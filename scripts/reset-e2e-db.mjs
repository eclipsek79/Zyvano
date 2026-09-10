/**
 * Empties the end-to-end database between runs.
 *
 * The E2E stack creates its database if it is missing and applies migrations through
 * the real migration runner, but re-running `CREATE DATABASE` on every run would mean
 * recreating the schema each time. Instead this removes the rows the suites produce so
 * a repeat run is reproducible and still exercises a genuinely migrated schema.
 *
 * The table list is discovered from the catalogue rather than hard-coded, so a new
 * migration cannot silently leave stale rows behind and make an assertion pass for the
 * wrong reason. `schema_migrations` is preserved: the schema must stay applied.
 *
 * Guarded on the database name ending in `_test` before anything is truncated.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const databaseUrl = process.env.DATABASE_URL ?? '';

if (!databaseUrl) {
  process.stderr.write('[reset-e2e-db] DATABASE_URL is not set.\n');
  process.exit(1);
}

const databaseName = (() => {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    return '';
  }
})();

if (!/_test$/.test(databaseName)) {
  process.stderr.write(
    `[reset-e2e-db] Refusing to truncate "${databaseName}": the name must end in _test.\n`,
  );
  process.exit(1);
}

async function psql(sql) {
  // Flags are passed one per argument and `-c` carries the statement explicitly, so
  // psql never drops into interactive mode and waits on stdin.
  const { stdout } = await execFileAsync(
    'psql',
    [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', sql],
    { maxBuffer: 1024 * 1024 * 16 },
  );
  return stdout.trim();
}

const tables = await psql(
  `SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
    ORDER BY tablename`,
);

const list = tables
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

if (list.length === 0) {
  process.stdout.write('[reset-e2e-db] no application tables found; nothing to do\n');
  process.exit(0);
}

// One TRUNCATE statement: CASCADE handles foreign keys, so the order of the list does
// not matter, and RESTART IDENTITY keeps sequences predictable across runs.
await psql(
  `TRUNCATE TABLE ${list.map((name) => `"${name}"`).join(', ')} RESTART IDENTITY CASCADE`,
);

process.stdout.write(`[reset-e2e-db] truncated ${list.length} table(s)\n`);
