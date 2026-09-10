/**
 * Job processing: retry, exponential backoff, dead-lettering, and late-result refusal.
 *
 * `tests/integration/lifecycle.test.ts` covers what a *successful* run of each job does.
 * This suite covers what happens when a job does not go to plan, which is where a
 * background system actually earns its keep:
 *
 *   - a handler that throws is retried by BullMQ with exponential backoff, and the
 *     durable `jobs` row records each attempt rather than failing on the first one,
 *   - once the attempt budget is exhausted the job dead-letters: the row stays `failed`
 *     with the final error, which is the operational record an operator replays from,
 *   - a generation cancelled while a worker holds it is never resurrected by that
 *     worker's late result, and produces no side effects,
 *   - a cancelled export is never rendered, and is never reported as verified.
 *
 * Everything here runs against the real consumer (`createQueueConsumer`), the real Redis
 * instance, the real durable job repository and the real worker handler table. Where a
 * deterministic *crash* is needed the handler is driven through a genuine failure path in
 * production code rather than by stubbing a module.
 *
 * The dead-letter case enqueues a real generation job and registers a handler for it that
 * throws, because a handler that fails *during* execution is the case the retry policy
 * exists for. A job name with no handler at all cannot be used for that: every declared
 * name now has an implementation, so the consumer's own guard is exercised separately by
 * an implementation gap staged in that test rather than by a real one existing here.
 *
 * The guard itself still matters in production — a partially rolled-out deploy, or a
 * queue drained by an older release, delivers job names this build may not know — so it
 * is covered on purpose rather than left to chance.
 */

import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getPool } from '@zyvano/server/db/pool';

import { buildTestApp, closeHarness, getContainer, resetDatabase } from '../helpers/app';
import {
  asActor,
  createActor,
  createProject,
  createScene,
  creditsUsed,
  generationRow,
  type Actor,
} from '../helpers/fixtures';
import { providerStub, stopProviderStub } from '../helpers/provider-stub';
import { createWorkerHandlers } from '../../apps/worker/src/index';
import { resetQueues, startTestWorker, waitFor, type TestWorker } from '../helpers/worker-harness';

const app = buildTestApp();

/**
 * Attaches a live worker for the duration of `fn`, then stops it.
 *
 * `extraHandlers` lets a test override a handler. That is how a handler which throws
 * *during execution* — a real crash, and the case the retry policy exists for — is
 * reproduced: the handler genuinely fails, so the queue's own retry, backoff and
 * dead-letter behaviour is what is observed.
 */
async function withWorker<T>(
  fn: () => Promise<T>,
  concurrency = 2,
  extraHandlers: Parameters<typeof startTestWorker>[2] = {},
): Promise<T> {
  const worker: TestWorker = await startTestWorker(getContainer(), concurrency, extraHandlers);
  try {
    return await fn();
  } finally {
    await worker.close();
  }
}

/** The lifecycle columns of a durable job row. */
async function jobRow(id: string): Promise<{
  status: string;
  attempts_made: number;
  max_attempts: number;
  last_error: string | null;
  progress: number;
  finished_at: Date | null;
}> {
  const result = await getPool().query(
    'SELECT status, attempts_made, max_attempts, last_error, progress, finished_at FROM jobs WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Job ${id} does not exist.`);
  return row;
}

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

/* ============================ retry and dead-letter =========================== */

describe('job retry and dead-letter behaviour', () => {
  it('retries a throwing handler with backoff, then dead-letters it with the real error', async () => {
    // A real generation job that is genuinely queued, with a handler that throws when it
    // runs. The durable row has real foreign keys (`organization_id`, `project_id`) and
    // the Redis job is genuinely written, so the retry policy is exercised end to end
    // rather than against a job that could not exist in production.
    const actor = await createActor(app, 'retry-deadletter@example.com');
    const projectId = await createProject(app, actor, 'Retry project');
    const maxAttempts = getContainer().config.worker.maxAttempts;
    expect(maxAttempts).toBeGreaterThan(1);

    const queued = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A film whose first attempt fails.' });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const generationId = queued.body.data.generation.id as string;

    const jobsForGeneration = await getContainer().repositories.jobs.findByGeneration(generationId);
    const jobId = String(jobsForGeneration[0]!.id);

    const enqueuedAt = Date.now();

    // The row exists as `queued` before any worker touches it, so a process that dies
    // between the two writes leaves a replayable record rather than a lost job.
    const initial = await jobRow(jobId);
    expect(initial.status).toBe('queued');
    expect(initial.attempts_made).toBe(0);
    expect(initial.max_attempts).toBe(maxAttempts);

    // Sample the row while the queue works through the attempt budget. This is what
    // distinguishes a genuine retry from a single immediate failure: the row must be
    // reported as still in progress while attempts remain.
    const samples: Array<{ status: string; attemptsMade: number }> = [];
    let settled: Awaited<ReturnType<typeof jobRow>> | null = null;

    await withWorker(
      async () => {
        settled = await waitFor(
          async () => {
            const row = await jobRow(jobId);
            samples.push({ status: row.status, attemptsMade: row.attempts_made });
            return row.finished_at ? row : null;
          },
          { label: 'job to exhaust its attempts', timeoutMs: 20_000, intervalMs: 25 },
        );
      },
      2,
      {
        GenerateScript: () => {
          throw new Error('The script provider returned no usable content.');
        },
      },
    );

    const final = settled!;
    const elapsedMs = Date.now() - enqueuedAt;

    // It dead-letters, carrying the message from the handler.
    expect(final.status).toBe('failed');
    expect(final.attempts_made).toBe(maxAttempts);
    expect(final.last_error).toContain('script provider returned no usable content');

    // Intermediate frames prove it was retried rather than failed once: at least one
    // sample shows the row still in progress with attempts remaining. `markRetrying`
    // deliberately leaves the status alone, so a retried job is never prematurely
    // recorded as failed.
    const retryingFrames = samples.filter(
      (sample) => sample.status === 'processing' && sample.attemptsMade < maxAttempts,
    );
    expect(
      retryingFrames.length,
      `expected a retry frame, saw ${JSON.stringify(samples)}`,
    ).toBeGreaterThan(0);

    // Exponential backoff actually elapsed between attempts. The configured base delay
    // is deliberately small in tests, so the assertion is a lower bound that a
    // no-backoff retry loop could not satisfy.
    const backoffMs = getContainer().config.worker.backoffMs;
    const minimumRetryWindow = backoffMs * (2 ** (maxAttempts - 1) - 1) * 0.5;
    expect(elapsedMs).toBeGreaterThanOrEqual(minimumRetryWindow);

    // Nothing was fabricated: the dead-lettered job is not left queued or processing, so
    // no operator replay loop can pick it up and burn worker slots indefinitely.
    const pending = await getContainer().repositories.jobs.listPending(200);
    expect(pending.map((row) => String(row.id))).not.toContain(jobId);
  });

  it('dead-letters a job whose name this worker does not implement instead of stranding it', async () => {
    // A job name can legitimately reach a queue that this worker build has no handler
    // for: a partially rolled-out deploy, or a queue drained by an older release. The
    // dangerous outcome is not the failure itself but leaving the durable row `queued`,
    // because `findStale` and `listPending` would then report it as live work forever and
    // an operator replay loop would keep re-dispatching it.
    //
    // Every name in the declared catalog is implemented, so the gap is staged deliberately
    // here. `startTestWorker` merges the production handler table with the overrides it is
    // given, so passing an explicit `undefined` removes one handler and reproduces exactly
    // the consumer's unhandled-name path — the same guard a stale worker build would hit.
    const maxAttempts = getContainer().config.worker.maxAttempts;

    // Every name in the declared catalog has an implementation, so the gap is staged
    // deliberately: the harness merges overrides over the production table and skips any
    // entry that is `undefined`, which reproduces exactly the stale-worker condition.
    const productionHandlers = createWorkerHandlers(getContainer());
    expect(productionHandlers.GenerateStoryboard, 'the production worker implements this').toBeTypeOf(
      'function',
    );

    // A real job against real rows: the durable record and the Redis job are both written
    // by the production queue. `GenerateStoryboard` is the name left without a handler on
    // the staged worker below.
    const actor = await createActor(app, 'no-handler@example.com');
    const projectId = await createProject(app, actor, 'Unhandled job project');

    const { jobId } = await getContainer().queue.enqueue(
      'GenerateStoryboard',
      { note: 'staged: no handler registered on this worker build' },
      { organizationId: actor.organizationId, projectId },
    );

    const initial = await jobRow(jobId);
    expect(initial.status).toBe('queued');

    await withWorker(
      async () => {
        const settled = await waitFor(
          async () => {
            const row = await jobRow(jobId);
            return row.finished_at ? row : null;
          },
          { label: 'unimplemented job to dead-letter', timeoutMs: 20_000, intervalMs: 25 },
        );

        // Without the consumer's guard the row would remain `queued` forever, and
        // `listPending`/`findStale` would keep offering it as live work.
        expect(settled.status).toBe('failed');
        expect(settled.attempts_made).toBe(maxAttempts);
        expect(settled.last_error).toContain('No handler registered for job');
        expect(settled.last_error).toContain('GenerateStoryboard');
      },
      1,
      { GenerateStoryboard: undefined },
    );

    // The row is terminal, so it is never offered to an operator as pending work.
    const pending = await getContainer().repositories.jobs.listPending(200);
    expect(pending.map((row) => String(row.id))).not.toContain(jobId);
  });

  it('records progress on the durable row while a long job is running', async () => {
    const actor = await createActor(app, 'progress@example.com');
    const projectId = await createProject(app, actor, 'Progress project');

    // Slow the provider so the job is still in flight when the row is sampled.
    providerStub.injectDelay({ pathIncludes: '/chat/completions', ms: 1200 });

    const queued = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A film that reports progress.' });
    const generationId = queued.body.data.generation.id as string;

    const jobs = await getContainer().repositories.jobs.findByGeneration(generationId);
    const jobId = jobs[0]!.id;

    await withWorker(async () => {
      // Progress is written by the handler through the job context, so the durable row
      // reflects real worker state rather than an estimate.
      const advanced = await waitFor(
        async () => {
          const row = await jobRow(jobId);
          return row.progress > 0 ? row : null;
        },
        { label: 'job progress to advance', timeoutMs: 20_000, intervalMs: 50 },
      );
      expect(advanced.progress).toBeGreaterThan(0);

      const completed = await waitFor(
        async () => {
          const row = await jobRow(jobId);
          return row.status === 'completed' ? row : null;
        },
        { label: 'job to complete', timeoutMs: 20_000 },
      );
      expect(completed.progress).toBe(100);
      expect(completed.finished_at).not.toBeNull();
    });
  });

  it('exposes stale in-flight work so an operator can recover after a worker dies', async () => {
    const actor = await createActor(app, 'stale@example.com');
    const projectId = await createProject(app, actor, 'Stale project');

    const queued = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A film whose worker dies.' });
    const generationId = queued.body.data.generation.id as string;

    const jobs = await getContainer().repositories.jobs.findByGeneration(generationId);
    const jobId = jobs[0]!.id;

    // Reproduce the post-crash state exactly: the worker claimed the generation and
    // started the job, then the process died before any result was written.
    await getContainer().repositories.generations.claim(generationId);
    await getContainer().repositories.jobs.markStarted(jobId);

    // The generation is genuinely stranded in `processing`, which is what recovery
    // discovery is for. A zero-minute threshold selects anything already started.
    const staleGenerations = await getContainer().repositories.generations.findStaleProcessing(0);
    expect(staleGenerations.map((row) => row.id)).toContain(generationId);

    const staleJobs = await getContainer().repositories.jobs.findStale(0);
    expect(staleJobs.map((row) => String(row.id))).toContain(jobId);

    // The API reports the stranded state truthfully rather than hiding it or claiming
    // completion. The UI shows a job that is genuinely still running.
    const detail = await asActor(request(app).get(`/api/v1/generations/${generationId}`), actor);
    expect(detail.status).toBe(200);
    expect(detail.body.data.status).toBe('processing');

    // Recovery operator flow. A stranded row is deliberately NOT retryable through the
    // public endpoint: `retry` accepts only a terminal generation, and a stranded one is
    // still `processing`. Accepting it would race the (possibly still alive) original
    // worker and could double-bill the workspace.
    const retried = await asActor(
      request(app).post(`/api/v1/generations/${generationId}/retry`),
      actor,
    ).send({});
    expect(retried.status, JSON.stringify(retried.body)).toBe(409);

    // The operator first marks the abandoned row as failed using the worker's own
    // repository, then the retry proceeds through the public API.
    await getContainer().repositories.generations.markFailed({
      id: generationId,
      errorCode: 'WORKER_LOST',
      errorMessage: 'The worker processing this job stopped responding.',
    });

    const retriedAgain = await asActor(
      request(app).post(`/api/v1/generations/${generationId}/retry`),
      actor,
    ).send({});
    expect(retriedAgain.status, JSON.stringify(retriedAgain.body)).toBe(202);
    const retryId = retriedAgain.body.data.id as string;
    expect(retryId).not.toBe(generationId);

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await generationRow(retryId);
          return row.status === 'completed' ? row : null;
        },
        { label: 'recovered generation to complete', timeoutMs: 20_000 },
      );
    });

    const scripts = await asActor(request(app).get(`/api/v1/projects/${projectId}/scripts`), actor);
    expect(scripts.body.data).toHaveLength(1);

    // The abandoned row is retained with the operator's incident code, so the failure is
    // auditable rather than silently erased.
    const abandoned = await generationRow(generationId);
    expect(abandoned.status).toBe('failed');
    expect(abandoned.error_code).toBe('WORKER_LOST');
  });
});

/* ======================== cancellation while in flight ======================== */

describe('cancellation while a worker holds the generation', () => {
  it('does not resurrect a cancelled generation and writes no side effects', async () => {
    const actor: Actor = await createActor(app, 'midflight@example.com');
    const projectId = await createProject(app, actor, 'Mid-flight project');

    const before = await creditsUsed(actor.organizationId);

    // Long enough that the cancel provably lands while the provider call is open.
    providerStub.injectDelay({ pathIncludes: '/chat/completions', ms: 3000 });

    const queued = await asActor(
      request(app).post(`/api/v1/projects/${projectId}/scripts/generate`),
      actor,
    ).send({ prompt: 'A film cancelled mid-flight.' });
    const generationId = queued.body.data.generation.id as string;

    const jobs = await getContainer().repositories.jobs.findByGeneration(generationId);
    const jobId = jobs[0]!.id;

    await withWorker(async () => {
      // Wait until the worker genuinely holds the row, so the cancel exercises the
      // in-flight path rather than the trivially-safe queued one.
      await waitFor(
        async () => {
          const row = await generationRow(generationId);
          return row.status === 'processing' ? row : null;
        },
        { label: 'generation to be claimed', timeoutMs: 20_000, intervalMs: 25 },
      );

      const cancelled = await asActor(
        request(app).post(`/api/v1/generations/${generationId}/cancel`),
        actor,
      ).send({});
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
      expect(cancelled.body.data.status).toBe('cancelled');

      // Let the in-flight provider call finish and the handler run to its end. The job
      // row reaching a terminal state is the signal that the late result has arrived.
      await waitFor(
        async () => {
          const row = await jobRow(jobId);
          return row.finished_at ? row : null;
        },
        { label: 'in-flight handler to finish', timeoutMs: 30_000, intervalMs: 50 },
      );
    });

    // The late result did not resurrect the cancelled generation: `markCompleted`
    // refuses to move a row out of `cancelled`.
    const final = await generationRow(generationId);
    expect(final.status).toBe('cancelled');
    expect(final.cancelled_at).not.toBeNull();
    // The claim set a non-zero floor before the provider was called, and a cancelled row
    // is frozen there. What matters is that it is nowhere near complete and that no
    // completion ever landed.
    expect(final.progress).toBeLessThan(100);
    expect(final.finished_at).not.toBeNull();

    // A cancelled generation is not billed.
    expect(final.credits_used).toBe(0);
    expect(await creditsUsed(actor.organizationId)).toBe(before);

    // And no content was written for work the user called off. A late result must not
    // leave an orphaned artifact behind that the user never asked for.
    const scripts = await asActor(request(app).get(`/api/v1/projects/${projectId}/scripts`), actor);
    expect(scripts.body.data).toHaveLength(0);

    // The project itself is untouched and still usable.
    const project = await asActor(request(app).get(`/api/v1/projects/${projectId}`), actor);
    expect(project.status).toBe(200);
    expect(project.body.data.name).toBe('Mid-flight project');
  });

  it('does not attach media or complete a scene whose generation was cancelled mid-flight', async () => {
    const actor = await createActor(app, 'midflight-scene@example.com');
    const projectId = await createProject(app, actor, 'Mid-flight scene project');
    const sceneId = await createScene(app, actor, projectId, { durationSeconds: 2 });

    // Delay the video artifact fetch so the cancel lands during the provider call.
    providerStub.injectDelay({ pathIncludes: '/predictions', ms: 3000 });

    const queued = await asActor(request(app).post('/api/v1/generations/scenes'), actor).send({
      sceneId,
      kind: 'video',
      prompt: 'A slow push across an empty square.',
      durationSeconds: 2,
    });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const generationId = queued.body.data.generation.id as string;

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await generationRow(generationId);
          return row.status === 'processing' ? row : null;
        },
        { label: 'scene generation to be claimed', timeoutMs: 20_000, intervalMs: 25 },
      );

      const cancelled = await asActor(
        request(app).post(`/api/v1/generations/${generationId}/cancel`),
        actor,
      ).send({});
      expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

      // Wait for the handler to drain past the provider call.
      const jobs = await getContainer().repositories.jobs.findByGeneration(generationId);
      const jobId = jobs[0]!.id;
      await waitFor(
        async () => {
          const row = await jobRow(jobId);
          return row.finished_at ? row : null;
        },
        { label: 'scene handler to finish', timeoutMs: 30_000, intervalMs: 50 },
      );
    });

    const final = await generationRow(generationId);
    expect(final.status).toBe('cancelled');

    // The scene was not marked complete and gained no preview: the cancelled work left
    // no artifact for the timeline or the render step to pick up.
    const scene = await getPool().query<{ status: string; preview_asset_id: string | null }>(
      'SELECT status, preview_asset_id FROM scenes WHERE id = $1',
      [sceneId],
    );
    expect(scene.rows[0]!.preview_asset_id).toBeNull();
    expect(scene.rows[0]!.status).not.toBe('completed');

    const assets = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM assets WHERE project_id = $1',
      [projectId],
    );
    expect(Number(assets.rows[0]!.count)).toBe(0);
  });
});

/* ============================== export job refusal ============================ */

describe('export job processing', () => {
  it('refuses to render a cancelled export and never reports it verified', async () => {
    const actor = await createActor(app, 'exportcancel@example.com');
    const projectId = await createProject(app, actor, 'Cancelled export project');
    const sceneId = await createScene(app, actor, projectId, { durationSeconds: 2 });

    // An export is only accepted once a scene carries real rendered media, so one clip
    // is produced first. This is genuine generated content, not a fixture.
    const sceneGeneration = await asActor(request(app).post('/api/v1/generations/scenes'), actor).send({
      sceneId,
      kind: 'video',
      prompt: 'A slow push across an empty square.',
      durationSeconds: 2,
    });
    const sceneGenerationId = sceneGeneration.body.data.generation.id as string;

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await generationRow(sceneGenerationId);
          return row.status === 'completed' ? row : null;
        },
        { label: 'scene clip to be generated', timeoutMs: 30_000 },
      );
    });

    // Queue the export with no worker attached, so it is genuinely still waiting.
    const requested = await asActor(request(app).post('/api/v1/exports'), actor).send({
      projectId,
      preset: 'web-720p',
      format: 'mp4',
      includeAudio: false,
    });
    expect(requested.status, JSON.stringify(requested.body)).toBe(202);
    const exportId = requested.body.data.export.id as string;
    expect(requested.body.data.export.status).toBe('queued');

    const cancelled = await asActor(
      request(app).post(`/api/v1/exports/${exportId}/cancel`),
      actor,
    ).send({});
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    const cancelledRow = await getPool().query<{ status: string; verified: boolean }>(
      'SELECT status, verified FROM exports WHERE id = $1',
      [exportId],
    );
    expect(cancelledRow.rows[0]!.status).toBe('cancelled');
    expect(cancelledRow.rows[0]!.verified).toBe(false);

    // Now start the worker. The queued job is delivered and refused: a cancelled export
    // must not be rendered, and must never be marked verified.
    await withWorker(async () => {
      const jobs = await getContainer().repositories.jobs.findByExport(exportId);
      const jobId = jobs[0]!.id;
      await waitFor(
        async () => {
          const row = await jobRow(jobId);
          return row.finished_at ? row : null;
        },
        { label: 'export job to be delivered and refused', timeoutMs: 30_000, intervalMs: 50 },
      );
    });

    const after = await getPool().query<{ status: string; verified: boolean }>(
      'SELECT status, verified FROM exports WHERE id = $1',
      [exportId],
    );
    expect(after.rows[0]!.status).toBe('cancelled');
    expect(after.rows[0]!.verified).toBe(false);

    // No file was produced for the cancelled export.
    const files = await getContainer().repositories.exports.listFiles(exportId);
    expect(files).toHaveLength(0);

    // And the download gate stays closed: nothing is offered that does not exist.
    const download = await asActor(
      request(app).get(`/api/v1/exports/${exportId}/download`),
      actor,
    );
    expect(download.status).toBeGreaterThanOrEqual(400);

    // The scene's generated clip is untouched, so the project remains exportable.
    const scene = await getPool().query<{ preview_asset_id: string | null }>(
      'SELECT preview_asset_id FROM scenes WHERE id = $1',
      [sceneId],
    );
    expect(scene.rows[0]!.preview_asset_id).toBeTruthy();
  });
});
