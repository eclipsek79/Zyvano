/**
 * PostgreSQL connection pool.
 *
 * A single pool per process, created lazily and reused. All queries go through
 * parameterized statements — never string interpolation — which is the primary
 * defence against SQL injection.
 */
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

import { getConfig } from '../config/env';
import { logger } from '../observability/logger';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const cfg = getConfig();
    pool = new Pool({
      connectionString: cfg.databaseUrl,
      max: cfg.databasePoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      application_name: 'zyvano',
    });

    pool.on('error', (error) => {
      logger.error({ err: error }, 'idle postgres client error');
    });
  }
  return pool;
}

/** Runs a parameterized query on the shared pool. */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const started = Date.now();
  try {
    return await getPool().query<T>(sql, params as never[]);
  } catch (error) {
    logger.error(
      { err: error, durationMs: Date.now() - started, sql: sql.slice(0, 400) },
      'postgres query failed',
    );
    throw error;
  }
}

/** Returns the first row, or null. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const result = await query<T>(sql, params);
  return result.rows[0] ?? null;
}

/**
 * Runs `fn` inside a transaction, committing on success and rolling back on any
 * thrown error. The client is always released.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error({ err: rollbackError }, 'transaction rollback failed');
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Verifies connectivity — used by health checks and startup validation. */
export async function checkDatabaseHealth(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Closes the pool (graceful shutdown / tests). */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}
