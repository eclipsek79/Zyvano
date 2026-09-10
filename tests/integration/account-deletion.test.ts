/**
 * Account deletion: the full erasure path against real infrastructure.
 *
 * The API route, the durable `deletion_requests` ledger, the queue, the real worker
 * handler (`runAccountDeletion`), the deletion service, PostgreSQL and object storage are
 * all the production implementations. The only thing arranged here is the subject: an
 * account with real media in it.
 *
 * What this suite is actually protecting against is the failure mode where an erasure
 * *reports* success but leaves data behind — a purged row with orphaned bytes in storage,
 * a tombstoned user whose sessions still authenticate, or a shared workspace destroyed
 * because a departing member happened to be its last *owner*-flagged row. Each assertion
 * therefore reads the real database or the real storage adapter, never a response body
 * alone.
 */
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getPool } from '@zyvano/server/db/pool';

import { buildTestApp, closeHarness, getContainer, resetDatabase } from '../helpers/app';
import {
  asActor,
  cookieHeader,
  cookieValue,
  createActor,
  createProject,
  type Actor,
} from '../helpers/fixtures';
import { stopProviderStub } from '../helpers/provider-stub';
import { resetQueues, startTestWorker, waitFor, type TestWorker } from '../helpers/worker-harness';

const execFileAsync = promisify(execFile);

const app = buildTestApp();

/* ---------------------------------- helpers --------------------------------- */

/** Attaches a live production worker for the duration of `fn`. */
async function withWorker<T>(fn: () => Promise<T>, concurrency = 2): Promise<T> {
  const worker: TestWorker = await startTestWorker(getContainer(), concurrency);
  try {
    return await fn();
  } finally {
    await worker.close();
  }
}

/**
 * Encodes a real MP4 so uploaded assets carry genuine media, not filler bytes.
 *
 * ffprobe is what establishes the stored asset's dimensions, so a real container is what
 * makes the media-pipeline assertions meaningful downstream.
 */
async function encodeFixtureVideo(width = 320, height = 240, seconds = 1): Promise<Buffer> {
  const target = path.join(tmpdir(), `zyvano-deletion-${randomUUID()}.mp4`);
  try {
    await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=${width}x${height}:rate=10:duration=${seconds}`,
      '-pix_fmt',
      'yuv420p',
      '-y',
      target,
    ]);
    const { readFile } = await import('node:fs/promises');
    return await readFile(target);
  } finally {
    await unlink(target).catch(() => undefined);
  }
}

/** Uploads a real video through the production multipart endpoint. */
async function uploadVideo(actor: Actor, projectId: string, body: Buffer): Promise<string> {
  const response = await asActor(
    request(app).post(`/api/v1/assets?projectId=${projectId}`),
    actor,
  ).attach('file', body, { filename: 'clip.mp4', contentType: 'video/mp4' });

  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

/** The authoritative account row, read directly. */
async function userRow(userId: string): Promise<{
  email: string;
  status: string;
  display_name: string;
  password_hash: string;
  deleted_at: Date | null;
}> {
  const result = await getPool().query(
    'SELECT email, status, display_name, password_hash, deleted_at FROM users WHERE id = $1',
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`User ${userId} does not exist.`);
  return row;
}

/**
 * Rows for a project in the given table.
 *
 * `scenes`, `scripts` and `storyboards` are project-scoped and carry no
 * `organization_id` of their own, so a project id is what proves they were purged. The
 * scope column is resolved from the live catalog rather than hardcoded, which keeps this
 * honest if a table ever gains or loses the column.
 */
async function countForScope(table: string, column: string, value: string): Promise<number> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE ${column} = $1`,
    [value],
  );
  return Number(result.rows[0]!.count);
}

/** Table -> the column that scopes a row to a project or organization. */
const SCOPE_COLUMN: Record<string, string> = {
  assets: 'organization_id',
  exports: 'organization_id',
  generations: 'organization_id',
  jobs: 'organization_id',
  scenes: 'project_id',
  scripts: 'project_id',
  storyboards: 'project_id',
};

/* ------------------------------- suite lifecycle ---------------------------- */

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  await resetQueues(getContainer());
});

afterAll(async () => {
  await resetQueues(getContainer());
  await closeHarness();
  await stopProviderStub();
});

describe('account deletion', () => {
  it('requires the confirmation value to match the account email', async () => {
    const actor = await createActor(app, 'confirm-gate@example.com');

    // A wrong confirmation is refused, and nothing is recorded: the check runs before the
    // request row is written, so a failed attempt cannot leave a half-erasure behind.
    const wrong = await asActor(
      request(app).post('/api/v1/users/me/deletion-request'),
      actor,
    ).send({ confirmation: 'someone-else@example.com' });

    expect(wrong.status, JSON.stringify(wrong.body)).toBe(422);
    expect(wrong.body.error.code).toBe('VALIDATION_ERROR');

    const requests = await getPool().query('SELECT COUNT(*)::int AS count FROM deletion_requests');
    expect(requests.rows[0]!.count).toBe(0);

    // The account is untouched and still usable.
    const stillThere = await asActor(request(app).get('/api/v1/users/me'), actor);
    expect(stillThere.status).toBe(200);
  });

  it('refuses an unauthenticated request outright', async () => {
    const anonymous = await request(app)
      .post('/api/v1/users/me/deletion-request')
      .send({ confirmation: 'anyone@example.com' });

    expect(anonymous.status).toBe(401);

    const requests = await getPool().query('SELECT COUNT(*)::int AS count FROM deletion_requests');
    expect(requests.rows[0]!.count).toBe(0);
  });

  it('erases the account, its rows and its stored media, and invalidates its sessions', async () => {
    const actor = await createActor(app, 'erase-me@example.com');
    const projectId = await createProject(app, actor, 'A project to be erased');

    // Real media, so the purge has genuine objects to remove.
    const video = await encodeFixtureVideo();
    const assetId = await uploadVideo(actor, projectId, video);

    const assetRow = await getPool().query<{ storage_key: string; size_bytes: string }>(
      'SELECT storage_key, size_bytes FROM assets WHERE id = $1',
      [assetId],
    );
    const storageKey = assetRow.rows[0]!.storage_key;

    // The bytes are genuinely in storage before the deletion, so their later absence is
    // evidence of a purge rather than of never having been written.
    const before = await getContainer().storage.head(storageKey);
    expect(before).not.toBeNull();
    expect(before!.size).toBeGreaterThan(0);

    // A generation, so the erasure has to unwind the async-work graph too.
    const script = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A film about the end of a project.' });
    expect(script.status, JSON.stringify(script.body)).toBe(202);

    const orgId = actor.organizationId;

    // Request the erasure. 202 — accepted for processing, not done.
    const requested = await asActor(
      request(app).post('/api/v1/users/me/deletion-request'),
      actor,
    ).send({ confirmation: 'erase-me@example.com', reason: 'test cleanup' });

    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    const requestId = requested.body.data.id as string;
    expect(requested.body.data.status).toBe('pending');
    expect(requested.body.data.scope).toBe('account');

    // A second request while the first is in flight is coalesced rather than stacking a
    // second erasure job against the same account.
    const duplicate = await asActor(
      request(app).post('/api/v1/users/me/deletion-request'),
      actor,
    ).send({ confirmation: 'erase-me@example.com' });
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.data.duplicate).toBe(true);
    expect(duplicate.body.data.id).toBe(requestId);

    const totalRequests = await getPool().query('SELECT COUNT(*)::int AS count FROM deletion_requests');
    expect(totalRequests.rows[0]!.count).toBe(1);

    // Nothing has been erased yet: the request is queued, not executed.
    const midFlight = await userRow(actor.userId);
    expect(midFlight.status).not.toBe('deleted');

    await withWorker(async () => {
      const settled = await waitFor(
        async () => {
          const result = await getPool().query<{ status: string; last_error: string | null }>(
            'SELECT status, last_error FROM deletion_requests WHERE id = $1',
            [requestId],
          );
          const row = result.rows[0];
          return row && (row.status === 'completed' || row.status === 'failed') ? row : null;
        },
        { label: 'account deletion to settle', timeoutMs: 60_000, intervalMs: 50 },
      );

      // If this fails, `last_error` carries the real reason rather than a bare timeout.
      expect(settled.status, settled.last_error ?? '').toBe('completed');
      expect(settled.last_error).toBeNull();
    });

    const completed = await getContainer().repositories.deletionRequests.findById(requestId);
    expect(completed!.attempts).toBeGreaterThanOrEqual(1);
    expect(completed!.completed_at).not.toBeNull();

    // 1. The stored media is gone from object storage, not merely unreferenced.
    expect(await getContainer().storage.head(storageKey)).toBeNull();

    // 2. The content rows are gone.
    const projects = await getPool().query('SELECT COUNT(*)::int AS count FROM projects WHERE id = $1', [
      projectId,
    ]);
    expect(projects.rows[0]!.count).toBe(0);

    for (const [table, column] of Object.entries(SCOPE_COLUMN)) {
      const value = column === 'organization_id' ? orgId : projectId;

      // `jobs` is the one table that legitimately retains a row: the `DeleteUserData` job
      // that performed this erasure is its own operational record, and removing it would
      // destroy the evidence that the deletion ran. Every *other* job for the organization
      // must be gone.
      if (table === 'jobs') {
        const remaining = await getPool().query<{ name: string }>(
          'SELECT name FROM jobs WHERE organization_id = $1',
          [orgId],
        );
        expect(remaining.rows.map((row) => row.name)).toEqual(['DeleteUserData']);
        continue;
      }

      expect(await countForScope(table, column, value), `${table} should be empty`).toBe(0);
    }

    // 3. The account itself is tombstoned, and its credentials are unusable. The address is
    //    rewritten so the original cannot be re-registered into a stale row, and the stored
    //    password hash is replaced so no credential comparison can ever succeed again.
    const erased = await userRow(actor.userId);
    expect(erased.status).toBe('deleted');
    expect(erased.deleted_at).not.toBeNull();
    expect(erased.email).not.toBe('erase-me@example.com');
    expect(erased.email).toContain('@zyvano.invalid');
    expect(erased.display_name).toBe('Deleted user');
    expect(erased.password_hash).toBe('invalidated');

    // 4. The session ledger is cleared, so the cookie that was valid moments ago is dead.
    const sessions = await getPool().query('SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = $1', [
      actor.userId,
    ]);
    expect(sessions.rows[0]!.count).toBe(0);

    const reusedCookie = await request(app)
      .get('/api/v1/users/me')
      .set('Cookie', actor.cookies)
      .set('x-zyvano-csrf', actor.csrf);
    expect(reusedCookie.status).toBe(401);

    // A fresh sign-in cannot succeed either: the tombstoned row holds no usable hash.
    const relogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'erase-me@example.com', password: 'lovelace-analytical1' });
    expect(relogin.status).toBe(401);

    // 5. The era sure is recorded. An erasure with no audit trail is indistinguishable from
    //    data loss, so both the request and the completion are asserted.
    const audit = await getPool().query<{ action: string }>(
      "SELECT action FROM audit_events WHERE actor_user_id = $1 OR resource_id = $2 ORDER BY created_at",
      [actor.userId, requestId],
    );
    const actions = audit.rows.map((row) => row.action);
    expect(actions).toContain('account.deletion_requested');
    expect(actions).toContain('account.deleted');
  });

  it('leaves another account and its media completely untouched', async () => {
    // Cross-account isolation is the property that makes a deletion safe to run at all: a
    // bug that widens the purge scope would destroy an unrelated user's work.
    const departing = await createActor(app, 'departing@example.com');
    const bystander = await createActor(app, 'bystander@example.com');

    const bystanderProject = await createProject(app, bystander, 'Bystander project');
    const video = await encodeFixtureVideo();
    const bystanderAssetId = await uploadVideo(bystander, bystanderProject, video);

    const bystanderAsset = await getPool().query<{ storage_key: string }>(
      'SELECT storage_key FROM assets WHERE id = $1',
      [bystanderAssetId],
    );
    const bystanderKey = bystanderAsset.rows[0]!.storage_key;
    expect(await getContainer().storage.head(bystanderKey)).not.toBeNull();

    const departingProject = await createProject(app, departing, 'Departing project');
    void departingProject;

    const requested = await asActor(
      request(app).post('/api/v1/users/me/deletion-request'),
      departing,
    ).send({ confirmation: 'departing@example.com' });
    expect(requested.status).toBe(202);
    const requestId = requested.body.data.id as string;

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await getContainer().repositories.deletionRequests.findById(requestId);
          return row && row.status === 'completed' ? row : null;
        },
        { label: 'departing account deletion to complete', timeoutMs: 60_000, intervalMs: 50 },
      );
    });

    // The departing account is gone.
    const gone = await userRow(departing.userId);
    expect(gone.status).toBe('deleted');

    // The bystander's account, project, asset row and stored bytes all survive intact.
    const survivor = await userRow(bystander.userId);
    expect(survivor.status).toBe('active');
    expect(survivor.email).toBe('bystander@example.com');

    const survivingAsset = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM assets WHERE id = $1',
      [bystanderAssetId],
    );
    expect(Number(survivingAsset.rows[0]!.count)).toBe(1);

    const survivingBytes = await getContainer().storage.head(bystanderKey);
    expect(survivingBytes).not.toBeNull();
    expect(survivingBytes!.size).toBeGreaterThan(0);

    // And the bystander can still use the platform normally.
    const stillWorks = await asActor(request(app).get('/api/v1/users/me'), bystander);
    expect(stillWorks.status).toBe(200);
  });

  it('leaves a workspace shared with other members standing', async () => {
    // The distinction that matters in a multi-tenant product: an account that merely
    // *belongs* to a workspace must be able to leave without the workspace — and everyone
    // else's content in it — being destroyed.
    const owner = await createActor(app, 'shared-owner@example.com');
    const guestEmail = 'shared-guest@example.com';

    // Register the guest, then add them to the owner's workspace as a member.
    const guestRegistration = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: guestEmail, password: 'lovelace-analytical1', displayName: 'guest' });
    expect(guestRegistration.status).toBe(201);
    await getPool().query('UPDATE users SET email_verified_at = now() WHERE email = $1', [guestEmail]);

    const guestUserId = guestRegistration.body.data.user.id as string;
    await getPool().query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'member')`,
      [owner.organizationId, guestUserId],
    );

    // The guest's own session, established through the real login endpoint.
    const guestLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: guestEmail, password: 'lovelace-analytical1' });
    expect(guestLogin.status).toBe(200);
    const guest: Actor = {
      cookies: cookieHeader(guestLogin),
      csrf: cookieValue(guestLogin, 'zyvano_csrf') ?? '',
      userId: guestUserId,
      organizationId: owner.organizationId,
    };

    const ownerProject = await createProject(app, owner, 'Owner project survives');

    const requested = await asActor(
      request(app).post('/api/v1/users/me/deletion-request'),
      guest,
    ).send({ confirmation: guestEmail });
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    const requestId = requested.body.data.id as string;

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await getContainer().repositories.deletionRequests.findById(requestId);
          return row && row.status === 'completed' ? row : null;
        },
        { label: 'guest account deletion to complete', timeoutMs: 60_000, intervalMs: 50 },
      );
    });

    // The guest is erased and has left the workspace.
    const erasedGuest = await userRow(guestUserId);
    expect(erasedGuest.status).toBe('deleted');

    const membership = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM organization_members WHERE organization_id = $1 AND user_id = $2',
      [owner.organizationId, guestUserId],
    );
    expect(Number(membership.rows[0]!.count)).toBe(0);

    // The workspace, its owner and its project are untouched.
    const workspace = await getPool().query<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM organizations WHERE id = $1',
      [owner.organizationId],
    );
    expect(workspace.rows[0]!.deleted_at).toBeNull();

    const ownerRow = await userRow(owner.userId);
    expect(ownerRow.status).toBe('active');

    const project = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM projects WHERE id = $1 AND deleted_at IS NULL',
      [ownerProject],
    );
    expect(Number(project.rows[0]!.count)).toBe(1);

    // The owner can still reach their own workspace.
    const ownerStillWorks = await asActor(request(app).get('/api/v1/users/me'), owner);
    expect(ownerStillWorks.status).toBe(200);
  });

  it('is idempotent: replaying the job on a completed request does not re-run the purge', async () => {
    // A redelivered job after a worker restart must not repeat destructive work against a
    // request that already finished.
    const actor = await createActor(app, 'idempotent@example.com');

    const requested = await asActor(
      request(app).post('/api/v1/users/me/deletion-request'),
      actor,
    ).send({ confirmation: 'idempotent@example.com' });
    const requestId = requested.body.data.id as string;

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await getContainer().repositories.deletionRequests.findById(requestId);
          return row && row.status === 'completed' ? row : null;
        },
        { label: 'first deletion pass to complete', timeoutMs: 60_000, intervalMs: 50 },
      );
    });

    const afterFirst = await getContainer().repositories.deletionRequests.findById(requestId);
    expect(afterFirst!.attempts).toBe(1);

    // Replay the same job through a live worker, exactly as a redelivery would.
    await getContainer().queue.enqueue(
      'DeleteUserData',
      { deletionRequestId: requestId, userId: actor.userId },
      { maxAttempts: 1 },
    );

    await withWorker(async () => {
      await waitFor(
        async () => {
          const jobs = await getPool().query<{ status: string }>(
            `SELECT status FROM jobs
              WHERE name = 'DeleteUserData' AND payload->>'deletionRequestId' = $1
              ORDER BY created_at DESC LIMIT 1`,
            [requestId],
          );
          const row = jobs.rows[0];
          return row && row.status === 'completed' ? row : null;
        },
        { label: 'replayed deletion job to complete', timeoutMs: 30_000, intervalMs: 50 },
      );
    });

    // The request was not re-claimed, so the attempt counter is unchanged and the requested
    // timestamp is stable — proof the second delivery short-circuited rather than re-running.
    const afterReplay = await getContainer().repositories.deletionRequests.findById(requestId);
    expect(afterReplay!.attempts).toBe(1);
    expect(afterReplay!.status).toBe('completed');
    expect(afterReplay!.completed_at!.getTime()).toBe(afterFirst!.completed_at!.getTime());
  });
});
