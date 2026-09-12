/**
 * Zyvano API entrypoint.
 *
 * Startup sequence: load and validate configuration (fail fast), verify the
 * database is reachable, install the built-in template catalog, then begin
 * serving. Shutdown is graceful so in-flight requests finish and the pool and
 * queue connections are released.
 */
import type { Server } from 'node:http';

import { buildContainer } from '@zyvano/server/container';
import { getConfig } from '@zyvano/server/config/env';
import { checkDatabaseHealth, closePool } from '@zyvano/server/db/pool';
import { logger } from '@zyvano/server/observability/logger';

import { createApp } from './app';

async function main(): Promise<void> {
  // Throws with a readable message listing every problem if configuration is
  // incomplete; nothing is served with a partially valid environment.
  const config = getConfig();

  logger.info(
    { env: config.nodeEnv, port: config.apiPort, logLevel: config.logLevel },
    'starting zyvano api',
  );

  const database = await checkDatabaseHealth();
  if (!database.ok) {
    logger.error({ error: database.error }, 'database is not reachable at startup');
    throw new Error(`Database unreachable: ${database.error ?? 'unknown error'}`);
  }
  logger.info({ latencyMs: database.latencyMs }, 'database connection verified');

  const container = buildContainer();

  try {
    // Idempotent: system templates are upserted on every boot so a fresh
    // deployment has a usable catalog without a separate seed step.
    await container.services.templates.seedSystemTemplates();
    logger.info('system templates verified');
  } catch (error) {
    // A failure here should not stop the API from serving; the catalog is
    // recoverable on the next boot.
    logger.error({ err: error }, 'could not seed system templates');
  }

  const app = createApp(container);

  const server: Server = app.listen(config.apiPort, () => {
    logger.info({ port: config.apiPort }, 'zyvano api listening');
  });

  server.headersTimeout = 65_000;
  server.requestTimeout = 300_000;

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown requested');

    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, 20_000);
    forceExit.unref();

    try {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await container.queue.close();
      await closePool();
      logger.info('shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'uncaught exception; shutting down');
    void shutdown('uncaughtException');
  });
}

void main().catch((error) => {
  // Configuration or startup failure: log with full detail and exit non-zero so
  // the orchestrator surfaces the problem instead of restarting silently.
  logger.error({ err: error }, 'fatal startup error');
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
