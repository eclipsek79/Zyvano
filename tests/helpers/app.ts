/**
 * Test harness for suites that need the real application graph.
 *
 * Builds the genuine container (real PostgreSQL, real Redis-backed queue) rather
 * than substituting fakes, because the bugs worth catching at this layer are
 * exactly the ones a fake would hide: a broken migration, a missing index, an
 * authorization clause that only the real repository query exercises.
 *
 * `resetDatabase` truncates every domain table between tests while preserving the
 * migration ledger, so each test starts from a known-empty state without paying
 * to re-run migrations.
 */
import { createApp } from '../../apps/api/src/app';
import { buildContainer, type Container } from '@zyvano/server/container';
import { closePool, getPool } from '@zyvano/server/db/pool';
import { runMigrations } from '@zyvano/server/db/migrate';

/**
 * Tables emptied between tests.
 *
 * `schema_migrations` is deliberately absent: migrations stay applied. Because the
 * statement below uses `CASCADE`, the list order does not matter for foreign keys;
 * it is grouped by domain purely for readability.
 */
const DOMAIN_TABLES = [
  // analytics / observability
  'usage_records',
  'usage_quotas',
  'audit_events',
  'notifications',
  'webhook_events',
  'retention_records',
  'deletion_requests',
  'asset_deletions',
  // async work
  'provider_requests',
  'generation_attempts',
  'generations',
  'jobs',
  'export_files',
  'exports',
  // project content
  'assets',
  'scenes',
  'storyboards',
  'scripts',
  'project_members',
  'projects',
  // identity and tenancy
  'api_keys',
  'organization_invitations',
  'organization_members',
  'organizations',
  'auth_tokens',
  'auth_attempts',
  'sessions',
  'users',
];

let migrated = false;
let container: Container | null = null;

/** Applies migrations once per process. */
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  await runMigrations();
  migrated = true;
}

/** Returns the shared container, building it on first use. */
export function getContainer(): Container {
  if (!container) container = buildContainer();
  return container;
}

/** Builds a fresh Express application bound to the shared container. */
export function buildTestApp() {
  return createApp(getContainer());
}

/**
 * Empties every domain table.
 *
 * The statement is built once and reused. `RESTART IDENTITY` keeps serial columns
 * (if any are ever added) deterministic; `CASCADE` handles foreign keys so the
 * order of the list above cannot cause a spurious failure.
 */
export async function resetDatabase(): Promise<void> {
  await ensureSchema();
  await getPool().query(`TRUNCATE TABLE ${DOMAIN_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

/** Releases the pool and the container's own connections. */
export async function closeHarness(): Promise<void> {
  if (container) {
    await container.close();
    container = null;
  }
  await closePool();
}

/**
 * Mints a valid session for a user by inserting a session row directly.
 *
 * Used only to arrange state for authorization tests. The sign-in flow itself is
 * exercised through the real endpoint in the auth tests.
 */
export async function insertSession(input: {
  userId: string;
  sessionTokenHash: string;
  csrfTokenHash: string;
  expiresAt: Date;
}): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at, rotated_at)
     VALUES ($1, $2, $3, $4, now())
     RETURNING id`,
    [input.userId, input.sessionTokenHash, input.csrfTokenHash, input.expiresAt],
  );
  return result.rows[0]!.id;
}
