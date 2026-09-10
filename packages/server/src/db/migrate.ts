/**
 * Deterministic SQL migration runner.
 *
 * Migrations are plain `.sql` files in `db/migrations`, applied in filename order
 * inside a transaction, and recorded in `schema_migrations`. Already-applied
 * files are skipped. This intentionally avoids a heavyweight ORM/migration
 * framework so the schema is readable and auditable as SQL.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { PoolClient } from 'pg';

import { getConfig } from '../config/env';
import { logger } from '../observability/logger';
import { getPool } from './pool';

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

function loadMigrationFiles(): MigrationFile[] {
  const entries = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  return entries.map((name) => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
    return {
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    };
  });
}

async function ensureMigrationsTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL DEFAULT 0
    )
  `);
}

async function appliedMigrations(client: PoolClient): Promise<Map<string, string>> {
  const result = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
  driftDetected: string[];
}

/**
 * Applies all pending migrations. Each migration runs in its own transaction so
 * a failure leaves the database at the last successful migration.
 */
export async function runMigrations(): Promise<MigrationResult> {
  const files = loadMigrationFiles();
  const client = await getPool().connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  const driftDetected: string[] = [];

  try {
    await ensureMigrationsTable(client);
    const already = await appliedMigrations(client);

    for (const file of files) {
      const previousChecksum = already.get(file.name);
      if (previousChecksum) {
        if (previousChecksum !== file.checksum) {
          // The file changed after being applied — surface it loudly rather than
          // silently diverging.
          driftDetected.push(file.name);
        }
        skipped.push(file.name);
        continue;
      }

      const started = Date.now();
      await client.query('BEGIN');
      try {
        await client.query(file.sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
          [file.name, file.checksum, Date.now() - started],
        );
        await client.query('COMMIT');
        applied.push(file.name);
        logger.info({ migration: file.name, durationMs: Date.now() - started }, 'migration applied');
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error({ err: error, migration: file.name }, 'migration failed');
        throw error;
      }
    }
  } finally {
    client.release();
  }

  if (driftDetected.length > 0) {
    logger.warn({ driftDetected }, 'applied migrations have changed on disk since they were run');
  }

  return { applied, skipped, driftDetected };
}

export interface MigrationStatusEntry {
  name: string;
  applied: boolean;
  appliedAt: string | null;
  drift: boolean;
}

export async function migrationStatus(): Promise<MigrationStatusEntry[]> {
  const files = loadMigrationFiles();
  const client = await getPool().connect();
  try {
    await ensureMigrationsTable(client);
    const result = await client.query<{ name: string; checksum: string; applied_at: Date }>(
      'SELECT name, checksum, applied_at FROM schema_migrations',
    );
    const byName = new Map(result.rows.map((row) => [row.name, row]));

    return files.map((file) => {
      const row = byName.get(file.name);
      return {
        name: file.name,
        applied: Boolean(row),
        appliedAt: row ? new Date(row.applied_at).toISOString() : null,
        drift: Boolean(row) && row!.checksum !== file.checksum,
      };
    });
  } finally {
    client.release();
  }
}

/** CLI entrypoint: `tsx src/db/migrate.ts up|status` */
async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  try {
    if (command === 'status') {
      const status = await migrationStatus();
      for (const entry of status) {
        const mark = entry.applied ? (entry.drift ? 'DRIFT' : 'applied') : 'pending';
        process.stdout.write(`${mark.padEnd(8)} ${entry.name}\n`);
      }
    } else if (command === 'up') {
      const result = await runMigrations();
      process.stdout.write(
        `applied ${result.applied.length} migration(s); ${result.skipped.length} already up to date\n`,
      );
    } else {
      process.stderr.write('usage: migrate.ts up|status\n');
      process.exitCode = 1;
    }
  } finally {
    const { closePool } = await import('./pool');
    await closePool();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    logger.error({ err: error }, 'migration command failed');
    process.exitCode = 1;
  });
}

export { getConfig };
