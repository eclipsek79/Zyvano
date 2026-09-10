/**
 * End-to-end integration of the generation and export lifecycles.
 *
 * Every layer here is the production implementation:
 *
 *   HTTP API (supertest against the real Express app)
 *     -> services -> repositories -> PostgreSQL
 *     -> BullMQ queue -> real Redis -> the worker's real handler table
 *     -> the real provider adapters -> a local provider contract server
 *     -> the real object-storage driver -> the real ffmpeg renderer
 *
 * Nothing about the lifecycle is simulated. Every assertion reads persisted state
 * written by that stack. The only substitution anywhere is the third-party vendor
 * endpoint, which is replaced by a local server speaking their published wire
 * protocols (see `tests/helpers/provider-stub.ts`), because the real vendors need
 * credentials this environment does not have.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { COOKIE_NAMES, CREDIT_COSTS } from '@zyvano/shared';
import { getPool } from '@zyvano/server/db/pool';

import { buildTestApp, closeHarness, getContainer, resetDatabase } from '../helpers/app';
import { providerStub, stopProviderStub } from '../helpers/provider-stub';
import { resetQueues, startTestWorker, waitFor, type TestWorker } from '../helpers/worker-harness';

const app = buildTestApp();

/* --------------------------------- utilities -------------------------------- */

function cookieValue(response: request.Response, name: string): string | undefined {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  if (!raw) return undefined;
  for (const entry of raw) {
    const separator = entry.indexOf('=');
    if (separator === -1) continue;
    if (entry.slice(0, separator) !== name) continue;
    const rest = entry.slice(separator + 1);
    const terminator = rest.indexOf(';');
    return terminator === -1 ? rest : rest.slice(0, terminator);
  }
  return undefined;
}

function cookieHeader(response: request.Response): string {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? [])
    .map((entry) => entry.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

interface Actor {
  cookies: string;
  csrf: string;
  userId: string;
  organizationId: string;
}

/**
 * Registers an account and marks its email verified.
 *
 * Verification is a real column (`users.email_verified_at`); flipping it directly is
 * arrangement, and the verification flow itself is covered by the auth suite.
 */
async function createActor(email: string): Promise<Actor> {
  const response = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: 'lovelace-analytical1', displayName: email.split('@')[0] })
    .set('user-agent', 'vitest');

  expect(response.status, JSON.stringify(response.body)).toBe(201);

  await getPool().query('UPDATE users SET email_verified_at = now() WHERE email = $1', [email]);

  return {
    cookies: cookieHeader(response),
    csrf: cookieValue(response, COOKIE_NAMES.CSRF) ?? '',
    userId: response.body.data.user.id as string,
    organizationId: response.body.data.organizations[0].id as string,
  };
}

/** Attaches the actor's session, CSRF token and active organization to a request. */
function asActor(req: request.Test, actor: Actor, organizationId?: string): request.Test {
  return req
    .set('Cookie', actor.cookies)
    .set('x-zyvano-csrf', actor.csrf)
    .set('x-zyvano-organization', organizationId ?? actor.organizationId);
}

async function createProject(actor: Actor, name: string): Promise<string> {
  const response = await asActor(request(app).post('/api/v1/projects'), actor).send({
    name,
    prompt: 'A short film about a city waking up.',
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

async function createScene(actor: Actor, projectId: string, durationSeconds = 2): Promise<string> {
  const response = await asActor(
    request(app).post(`/api/v1/projects/${projectId}/scenes`),
    actor,
  ).send({
    title: 'Opening shot',
    prompt: 'A slow push across an empty square at sunrise.',
    durationSeconds,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

/** Reads a generation row directly, which is the authoritative lifecycle record. */
async function generationRow(id: string): Promise<{
  status: string;
  progress: number;
  error_code: string | null;
  error_message: string | null;
  credits_reserved: number;
  credits_used: number;
  started_at: Date | null;
  finished_at: Date | null;
  cancelled_at: Date | null;
}> {
  const result = await getPool().query(
    `SELECT status, progress, error_code, error_message, credits_reserved, credits_used,
            started_at, finished_at, cancelled_at
       FROM generations WHERE id = $1`,
    [id],
  );
  expect(result.rows[0], `generation ${id} should exist`).toBeDefined();
  return result.rows[0];
}

async function creditsUsed(organizationId: string): Promise<number> {
  const result = await getPool().query<{ credits_used: number }>(
    `SELECT COALESCE(SUM(credits_used), 0)::int AS credits_used
       FROM usage_quotas WHERE organization_id = $1`,
    [organizationId],
  );
  return Number(result.rows[0]?.credits_used ?? 0);
}

/**
 * Runs `fn` with a live worker attached to the real queues, then stops it.
 *
 * Each test owns its worker so that "what happens when nothing is processing the
 * queue yet" stays expressible — which is what makes the cancellation test able to
 * cancel a genuinely queued job rather than racing the worker for it.
 */
async function withWorker<T>(fn: () => Promise<T>, concurrency = 2): Promise<T> {
  const worker: TestWorker = await startTestWorker(getContainer(), concurrency);
  try {
    return await fn();
  } finally {
    await worker.close();
  }
}

/* ------------------------------- suite lifecycle ---------------------------- */

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  providerStub.reset();
  await resetDatabase();
  await resetQueues(getContainer());
});

afterAll(async () => {
  await resetQueues(getContainer());
  await closeHarness();
  await stopProviderStub();
});

/* ============================== generation lifecycle ========================= */

describe('script generation lifecycle', () => {
  it('persists queued -> processing -> completed and writes a real script from the provider', async () => {
    const actor = await createActor('lifecycle@example.com');
    const projectId = await createProject(actor, 'Lifecycle project');

    providerStub.setScriptText('Cut to the Chorus\n\n1. The lights come up.\n2. The crowd leans in.');

    // Slow the provider slightly so the `processing` state is observable. Without
    // this the transition is real but too brief to sample.
    providerStub.injectDelay({ pathIncludes: '/chat/completions', ms: 900 });

    const queued = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A launch film for a coffee roastery.', tone: 'warm', language: 'en' });

    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const generationId = queued.body.data.generation.id as string;

    // The HTTP response reports the row as inserted, before any worker touched it.
    expect(queued.body.data.generation.status).toBe('queued');
    expect(queued.body.data.generation.kind).toBe('script');

    // The durable job row is written in the same operation as the generation.
    const jobs = await getContainer().repositories.jobs.findByGeneration(generationId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.name).toBe('GenerateScript');
    expect(jobs[0]!.status).toBe('queued');

    await withWorker(async () => {
      const processing = await waitFor(
        async () => {
          const row = await generationRow(generationId);
          return row.status === 'processing' ? row : null;
        },
        { label: 'generation to reach processing', timeoutMs: 15_000 },
      );
      expect(processing.started_at).not.toBeNull();

      const done = await waitFor(
        async () => {
          const row = await generationRow(generationId);
          return row.status === 'completed' ? row : null;
        },
        { label: 'generation to complete', timeoutMs: 20_000 },
      );
      expect(done.progress).toBe(100);
      expect(done.finished_at).not.toBeNull();
      expect(done.error_code).toBeNull();
      // Credits are settled at the provider's reported usage, not the reservation.
      expect(done.credits_used).toBeGreaterThan(0);
    });

    // The script exists because the worker persisted the provider's actual output.
    expect(providerStub.callsMatching('/chat/completions').length).toBeGreaterThan(0);

    const scripts = await asActor(request(app).get(`/api/v1/projects/${projectId}/scripts`), actor);
    expect(scripts.status).toBe(200);
    expect(scripts.body.data).toHaveLength(1);
    expect(scripts.body.data[0].content).toContain('Cut to the Chorus');

    // The attempt and the provider traffic record describe what actually happened.
    const attempts = await getContainer().repositories.generations.listAttempts(generationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('completed');
    expect(attempts[0]!.external_request_id).toBe('chatcmpl-stub-1');

    const providerRequests = await getPool().query<{ status: string; capability: string }>(
      'SELECT status, capability FROM provider_requests WHERE generation_id = $1',
      [generationId],
    );
    expect(providerRequests.rows).toHaveLength(1);
    expect(providerRequests.rows[0]!.status).toBe('completed');
    expect(providerRequests.rows[0]!.capability).toBe('text');

    // Usage was metered against the organization.
    const usage = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM usage_records WHERE generation_id = $1',
      [generationId],
    );
    expect(Number(usage.rows[0]!.count)).toBe(1);
  });

  it('deduplicates a repeated idempotency key instead of charging twice', async () => {
    const actor = await createActor('idempotent@example.com');
    const projectId = await createProject(actor, 'Idempotent project');
    const key = 'idem-key-0001';

    const first = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A product teaser.', idempotencyKey: key });

    const second = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A product teaser.', idempotencyKey: key });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.data.deduplicated).toBe(true);
    expect(second.body.data.generation.id).toBe(first.body.data.generation.id);

    const rows = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM generations WHERE project_id = $1',
      [projectId],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });
});

/* ============================ failure, retry, credits ======================== */

describe('provider failure handling', () => {
  it('records a real failure, releases the reserved credits, and leaves the project usable', async () => {
    const actor = await createActor('failure@example.com');
    const projectId = await createProject(actor, 'Failure project');

    const before = await creditsUsed(actor.organizationId);

    providerStub.injectFailure({
      pathIncludes: '/chat/completions',
      times: 1,
      status: 500,
      body: JSON.stringify({ error: { message: 'upstream exploded' } }),
    });

    const queued = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A film that will fail.' });
    const generationId = queued.body.data.generation.id as string;

    await withWorker(async () => {
      const failed = await waitFor(
        async () => {
          const row = await generationRow(generationId);
          return row.status === 'failed' ? row : null;
        },
        { label: 'generation to fail', timeoutMs: 20_000 },
      );
      expect(failed.error_code).toBe('HTTP_500');
      expect(failed.error_message).toContain('500');
      // The reservation was released because the provider was never billed.
      expect(failed.credits_used).toBe(0);
    });

    // Reserve-then-release nets to zero: a failed generation costs the workspace nothing.
    expect(await creditsUsed(actor.organizationId)).toBe(before);

    // The failure is fully attributed, not just a status column.
    const attempts = await getContainer().repositories.generations.listAttempts(generationId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('failed');
    expect(attempts[0]!.error_code).toBe('HTTP_500');

    const providerRequests = await getPool().query<{ status: string; error_code: string | null }>(
      'SELECT status, error_code FROM provider_requests WHERE generation_id = $1',
      [generationId],
    );
    expect(providerRequests.rows[0]!.status).toBe('failed');
    expect(providerRequests.rows[0]!.error_code).toBe('HTTP_500');

    // The user is notified through the real notification record.
    const notifications = await getPool().query<{ type: string }>(
      'SELECT type FROM notifications WHERE resource_id = $1',
      [generationId],
    );
    expect(notifications.rows.map((row) => row.type)).toContain('generation.failed');

    // Nothing was fabricated: no script exists for a generation that never ran.
    const scripts = await asActor(request(app).get(`/api/v1/projects/${projectId}/scripts`), actor);
    expect(scripts.body.data).toHaveLength(0);

    // The project itself is intact and still usable.
    const project = await asActor(request(app).get(`/api/v1/projects/${projectId}`), actor);
    expect(project.status).toBe(200);
    expect(project.body.data.name).toBe('Failure project');

    // And a retry against a healthy provider now succeeds.
    const retried = await asActor(
      request(app).post(`/api/v1/generations/${generationId}/retry`),
      actor,
    ).send({});
    expect(retried.status).toBe(202);
    const retryId = retried.body.data.id as string;
    expect(retryId).not.toBe(generationId);

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await generationRow(retryId);
          return row.status === 'completed' ? row : null;
        },
        { label: 'retried generation to complete', timeoutMs: 20_000 },
      );
    });

    const afterRetry = await asActor(
      request(app).get(`/api/v1/projects/${projectId}/scripts`),
      actor,
    );
    expect(afterRetry.body.data).toHaveLength(1);

    // The original failure is preserved as history rather than overwritten.
    const original = await generationRow(generationId);
    expect(original.status).toBe('failed');
  });

  it('fails with a timeout error when the provider never answers, without corrupting the project', async () => {
    const actor = await createActor('timeout@example.com');
    const projectId = await createProject(actor, 'Timeout project');
    const sceneId = await createScene(actor, projectId, 2);

    const scriptCountBefore = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM scripts WHERE project_id = $1',
      [projectId],
    );

    // Hold the connection open well past the configured provider timeout. The
    // adapter aborts; the worker must record a TIMEOUT and stop.
    providerStub.injectFailure({
      pathIncludes: '/chat/completions',
      times: 1,
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: 'too late' } }] }),
      delayMs: 30_000,
    });

    const queued = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/storyboards/generate`),
      actor,
    ).send({ sceneCount: 3 });
    const generationId = queued.body.data.generation.id as string;

    await withWorker(async () => {
      const failed = await waitFor(
        async () => {
          const row = await generationRow(generationId);
          return row.status === 'failed' ? row : null;
        },
        { label: 'generation to time out', timeoutMs: 30_000 },
      );
      expect(failed.error_code).toBe('TIMEOUT');
    });

    // A timed-out storyboard must not have written partial scenes or a partial script.
    const scenes = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM scenes WHERE project_id = $1',
      [projectId],
    );
    expect(Number(scenes.rows[0]!.count)).toBe(1); // only the one we created manually
    expect(scenes.rows[0]!.count).not.toBe('4');

    const storyboards = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM storyboards WHERE project_id = $1',
      [projectId],
    );
    expect(Number(storyboards.rows[0]!.count)).toBe(0);

    const scriptCountAfter = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM scripts WHERE project_id = $1',
      [projectId],
    );
    expect(scriptCountAfter.rows[0]!.count).toBe(scriptCountBefore.rows[0]!.count);

    // The project and its scene remain readable and consistent.
    const project = await asActor(request(app).get(`/api/v1/projects/${projectId}`), actor);
    expect(project.status).toBe(200);

    const sceneRows = await getPool().query<{ status: string; preview_asset_id: string | null }>(
      'SELECT status, preview_asset_id FROM scenes WHERE id = $1',
      [sceneId],
    );
    expect(sceneRows.rows[0]!.status).toBe('queued');
    expect(sceneRows.rows[0]!.preview_asset_id).toBeNull();
  });

  it('marks the scene failed when its media generation fails, and attaches nothing', async () => {
    const actor = await createActor('scenefail@example.com');
    const projectId = await createProject(actor, 'Scene failure project');
    const sceneId = await createScene(actor, projectId, 2);

    providerStub.injectFailure({
      pathIncludes: '/images/generations',
      times: 1,
      status: 500,
      body: JSON.stringify({ error: { message: 'image backend down' } }),
    });

    const queued = await asActor(
      request(app).post('/api/v1/generations/scenes'),
      actor,
    ).send({ sceneId, kind: 'image', prompt: 'A rooftop at dusk.' });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const generationId = queued.body.data.generation.id as string;

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await generationRow(generationId);
          return row.status === 'failed' ? row : null;
        },
        { label: 'scene generation to fail', timeoutMs: 20_000 },
      );
    });

    const sceneRows = await getPool().query<{ status: string; preview_asset_id: string | null }>(
      'SELECT status, preview_asset_id FROM scenes WHERE id = $1',
      [sceneId],
    );
    expect(sceneRows.rows[0]!.status).toBe('failed');
    expect(sceneRows.rows[0]!.preview_asset_id).toBeNull();

    const assets = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM assets WHERE project_id = $1',
      [projectId],
    );
    expect(Number(assets.rows[0]!.count)).toBe(0);
  });
});

/* ================================= cancellation ============================== */

describe('cancellation', () => {
  it('cancels a queued generation before any worker runs, and a later worker cannot resurrect it', async () => {
    const actor = await createActor('cancel@example.com');
    const projectId = await createProject(actor, 'Cancellation project');

    const before = await creditsUsed(actor.organizationId);

    // No worker is attached, so the job is genuinely sitting in the queue.
    const queued = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A film that gets cancelled.' });
    const generationId = queued.body.data.generation.id as string;
    expect(queued.body.data.generation.status).toBe('queued');

    const cancelled = await asActor(
      request(app).post(`/api/v1/generations/${generationId}/cancel`),
      actor,
    ).send({});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');

    const cancelledRow = await generationRow(generationId);
    expect(cancelledRow.cancelled_at).not.toBeNull();
    expect(cancelledRow.finished_at).not.toBeNull();

    // The reservation is returned: a cancelled generation is not billed.
    expect(await creditsUsed(actor.organizationId)).toBe(before);

    // Start the worker. The job it eventually receives must be refused, not run.
    await withWorker(async () => {
      const job = await waitFor(
        async () => {
          const jobs = await getContainer().repositories.jobs.findByGeneration(generationId);
          const row = jobs[0];
          return row && row.status === 'completed' ? row : null;
        },
        { label: 'queued job to be delivered and refused', timeoutMs: 20_000 },
      );
      expect(job.status).toBe('completed');
    });

    // The late delivery did not resurrect the cancelled generation.
    const afterWorker = await generationRow(generationId);
    expect(afterWorker.status).toBe('cancelled');
    expect(afterWorker.progress).toBe(0);

    // And no provider call was made for it.
    expect(providerStub.callsMatching('/chat/completions')).toHaveLength(0);

    const scripts = await asActor(request(app).get(`/api/v1/projects/${projectId}/scripts`), actor);
    expect(scripts.body.data).toHaveLength(0);
  });

  it('refuses to cancel a generation that already completed', async () => {
    const actor = await createActor('cancel-done@example.com');
    const projectId = await createProject(actor, 'Completed project');

    const queued = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A film that completes.' });
    const generationId = queued.body.data.generation.id as string;

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await generationRow(generationId);
          return row.status === 'completed' ? row : null;
        },
        { label: 'generation to complete', timeoutMs: 20_000 },
      );
    });

    const attempt = await asActor(
      request(app).post(`/api/v1/generations/${generationId}/cancel`),
      actor,
    ).send({});
    expect(attempt.status).toBe(409);
  });
});

/* =================================== exports ================================= */

describe('export lifecycle', () => {
  it('renders a verified, downloadable video file through the real render job', async () => {
    const actor = await createActor('export@example.com');
    const projectId = await createProject(actor, 'Export project');
    const sceneId = await createScene(actor, projectId, 2);

    // A scene becomes renderable only once it has real generated media attached, so
    // the render path is exercised against an actual encoded clip.
    const sceneGeneration = await asActor(
      request(app).post('/api/v1/generations/scenes'),
      actor,
    ).send({ sceneId, kind: 'video', prompt: 'A slow push across an empty square.', durationSeconds: 2 });
    expect(sceneGeneration.status, JSON.stringify(sceneGeneration.body)).toBe(202);
    const sceneGenerationId = sceneGeneration.body.data.generation.id as string;

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await generationRow(sceneGenerationId);
          return row.status === 'completed' ? row : null;
        },
        { label: 'scene video generation to complete', timeoutMs: 30_000 },
      );
    });

    // The generated clip is attached to the scene, and its bytes are in storage.
    const sceneRows = await getPool().query<{ status: string; preview_asset_id: string }>(
      'SELECT status, preview_asset_id FROM scenes WHERE id = $1',
      [sceneId],
    );
    expect(sceneRows.rows[0]!.status).toBe('completed');
    const previewAssetId = sceneRows.rows[0]!.preview_asset_id;
    expect(previewAssetId).toBeTruthy();

    const assetRows = await getPool().query<{ storage_key: string; size_bytes: string; kind: string }>(
      'SELECT storage_key, size_bytes, kind FROM assets WHERE id = $1',
      [previewAssetId],
    );
    const assetHead = await getContainer().storage.head(assetRows.rows[0]!.storage_key);
    expect(assetHead).not.toBeNull();
    expect(assetHead!.size).toBeGreaterThan(0);

    // Queue the render.
    const requested = await asActor(request(app).post('/api/v1/exports'), actor).send({
      projectId,
      preset: 'web-720p',
      format: 'mp4',
      includeAudio: false,
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    const exportId = requested.body.data.export.id as string;
    expect(requested.body.data.export.status).toBe('queued');

    // Before the worker runs there is no file, and the download gate must say so.
    const premature = await asActor(
      request(app).get(`/api/v1/exports/${exportId}/download`),
      actor,
    );
    expect(premature.status).toBe(409);

    await withWorker(async () => {
      const completed = await waitFor(
        async () => {
          const row = await getPool().query<{ status: string; verified: boolean; progress: number }>(
            'SELECT status, verified, progress FROM exports WHERE id = $1',
            [exportId],
          );
          const record = row.rows[0];
          return record && record.status === 'completed' ? record : null;
        },
        { label: 'export to complete', timeoutMs: 90_000 },
      );
      // Completion is gated on the worker verifying the object exists in storage.
      expect(completed.verified).toBe(true);
      expect(completed.progress).toBe(100);
    });

    // The produced object is a real MP4 with a non-zero size.
    const files = await getContainer().repositories.exports.listFiles(exportId);
    expect(files).toHaveLength(1);
    const storageKey = files[0]!.storage_key as string;
    const head = await getContainer().storage.head(storageKey);
    expect(head).not.toBeNull();
    expect(head!.size).toBeGreaterThan(0);

    const bytes = await getContainer().storage.get(storageKey);
    expect(bytes.byteLength).toBe(head!.size);
    // ISO base media file format: the 'ftyp' box at offset 4 proves this is a
    // container file, not an empty or truncated artifact.
    expect(bytes.subarray(4, 8).toString('ascii')).toBe('ftyp');

    // The export record carries the real probed properties.
    const asset = await getPool().query<{ width: number; height: number; duration_seconds: string }>(
      'SELECT width, height, duration_seconds FROM assets WHERE storage_key = $1',
      [storageKey],
    );
    expect(asset.rows[0]!.width).toBe(1280);
    expect(asset.rows[0]!.height).toBe(720);
    expect(Number(asset.rows[0]!.duration_seconds)).toBeGreaterThan(0);

    // Only now does the download gate release a URL. This suite runs on the local
    // filesystem driver, which has no HTTP origin of its own, so the gate returns this
    // API's byte-streaming endpoint rather than a `local://` marker no client could fetch.
    const download = await asActor(request(app).get(`/api/v1/exports/${exportId}/download`), actor);
    expect(download.status, JSON.stringify(download.body)).toBe(200);
    expect(download.body.data.url).toBe(`/api/v1/exports/${exportId}/file?download=1`);
    expect(download.body.data.filename).toContain(exportId);

    // The endpoint that URL points at really serves the file: the advertised download
    // path is proven to work rather than merely returned.
    const streamed = await asActor(
      request(app).get(download.body.data.url as string),
      actor,
    );
    expect(streamed.status, JSON.stringify(streamed.body)).toBe(200);
    expect(streamed.headers['content-disposition']).toContain('attachment');
    expect(streamed.headers['content-disposition']).toContain(exportId);
    expect(streamed.body.byteLength).toBeGreaterThan(0);
    expect(streamed.body.subarray(4, 8).toString('ascii')).toBe('ftyp');

    const detail = await asActor(request(app).get(`/api/v1/exports/${exportId}`), actor);
    expect(detail.body.data.status).toBe('completed');
    expect(detail.body.data.verified).toBe(true);
    expect(detail.body.data.files).toHaveLength(1);
    expect(detail.body.data.files[0].url).toBeTruthy();
  });

  it('fails an export whose scene has no rendered media, rather than producing an empty file', async () => {
    const actor = await createActor('export-empty@example.com');
    const projectId = await createProject(actor, 'Empty export project');
    await createScene(actor, projectId, 2);

    // The refusal happens at request time, before any worker is involved.
    const attempt = await asActor(request(app).post('/api/v1/exports'), actor).send({
      projectId,
      preset: 'web-720p',
      format: 'mp4',
      includeAudio: false,
    });

    expect(attempt.status).toBe(422);
    expect(JSON.stringify(attempt.body)).toMatch(/rendered/i);

    const exports = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM exports WHERE project_id = $1',
      [projectId],
    );
    expect(Number(exports.rows[0]!.count)).toBe(0);
  });
});

/* =============================== credit accounting =========================== */

describe('credit accounting', () => {
  it('reserves before dispatch and settles at the provider-reported cost', async () => {
    const actor = await createActor('credits@example.com');
    const projectId = await createProject(actor, 'Credits project');

    const queued = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A credits test.' });
    const generationId = queued.body.data.generation.id as string;

    // The reservation is persisted on the row before the worker runs.
    const reserved = await generationRow(generationId);
    expect(reserved.credits_reserved).toBe(CREDIT_COSTS.script);
    expect(reserved.credits_used).toBe(0);

    const reservedQuota = await creditsUsed(actor.organizationId);
    expect(reservedQuota).toBe(CREDIT_COSTS.script);

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await generationRow(generationId);
          return row.status === 'completed' ? row : null;
        },
        { label: 'generation to complete', timeoutMs: 20_000 },
      );
    });

    // Settlement replaces the reservation with the real metered cost. The stub
    // reports 460 tokens, which the adapter converts to 1 credit.
    const settled = await generationRow(generationId);
    expect(settled.credits_used).toBe(1);
    expect(await creditsUsed(actor.organizationId)).toBe(1);
  });
});
