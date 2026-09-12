/**
 * Health endpoints.
 *
 * `/health` is a liveness probe (the process is up). `/health/ready` is a
 * readiness probe that verifies the dependencies the API actually needs, so an
 * orchestrator does not route traffic to an instance that cannot serve it.
 */
import { Router } from 'express';

import { checkDatabaseHealth } from '@zyvano/server/db/pool';

import { asyncHandler } from '../http/errors';
import { ok } from '../http/respond';
import type { Container } from '@zyvano/server/container';

export function createHealthRouter(container: Container): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    ok(res, {
      status: 'ok',
      service: 'zyvano-api',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  router.get(
    '/ready',
    asyncHandler(async (_req, res) => {
      const database = await checkDatabaseHealth();
      const queue = await container.queue.health();

      // Storage liveness: a HEAD against a key that cannot exist proves the
      // backend is reachable without writing anything. A missing object is a
      // successful probe; only a transport/auth failure throws.
      let storage: { ok: boolean; error?: string };
      try {
        await container.storage.exists('__healthcheck__/probe');
        storage = { ok: true };
      } catch (error) {
        storage = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }

      const ready = database.ok && queue.ok && storage.ok;
      res.status(ready ? 200 : 503).json({
        data: {
          status: ready ? 'ready' : 'degraded',
          checks: {
            database: { ok: database.ok, latencyMs: database.latencyMs },
            queue: { ok: queue.ok, queues: queue.queues, error: queue.error ?? null },
            storage: {
              ok: storage.ok,
              driver: container.storage.driver,
              error: storage.error ?? null,
            },
          },
          timestamp: new Date().toISOString(),
        },
      });
    }),
  );

  return router;
}
