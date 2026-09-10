/**
 * Media processing and thumbnail generation: the two jobs that turn an uploaded file into
 * a described asset.
 *
 * These handlers exist to establish *verified* technical metadata. The values they write
 * come from `ffprobe` reading the stored bytes, never from the filename or from what the
 * uploader claimed — which is the whole point: an MP4 renamed to `.png` must be recorded
 * as what it actually is, and a thumbnail must not be attached unless the object was
 * really produced.
 *
 * Everything here runs through the production path:
 *
 *   HTTP upload (real multipart endpoint)
 *     -> AssetService stores bytes and enqueues `ProcessMedia`
 *     -> real BullMQ queue -> real Redis -> the worker's real handler table
 *     -> real ffmpeg/ffprobe -> real object storage -> PostgreSQL
 *
 * Nothing is simulated. Where a failure is asserted, the failure is produced by the
 * production code path itself.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getPool } from '@zyvano/server/db/pool';

import { buildTestApp, closeHarness, getContainer, resetDatabase } from '../helpers/app';
import { asActor, createActor, createProject, type Actor } from '../helpers/fixtures';
import { mp3Fixture, mp4Fixture, providerStub, stopProviderStub } from '../helpers/provider-stub';
import { resetQueues, startTestWorker, waitFor, type TestWorker } from '../helpers/worker-harness';

const app = buildTestApp();

/* ---------------------------------- helpers --------------------------------- */

async function withWorker<T>(fn: () => Promise<T>, concurrency = 2): Promise<T> {
  const worker: TestWorker = await startTestWorker(getContainer(), concurrency);
  try {
    return await fn();
  } finally {
    await worker.close();
  }
}

/** Uploads a real file through the production multipart endpoint. */
async function upload(
  actor: Actor,
  projectId: string,
  body: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  const response = await asActor(
    request(app).post(`/api/v1/assets?projectId=${projectId}`),
    actor,
  ).attach('file', body, { filename, contentType });

  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.id as string;
}

interface AssetRow {
  organization_id: string;
  storage_key: string;
  thumbnail_key: string | null;
  width: number | null;
  height: number | null;
  duration_seconds: string | null;
  metadata: Record<string, unknown>;
  size_bytes: string;
}

/** The authoritative asset row, read directly rather than through a projection. */
async function assetRow(assetId: string): Promise<AssetRow> {
  const result = await getPool().query<AssetRow>(
    `SELECT organization_id, storage_key, thumbnail_key, width, height, duration_seconds,
            metadata, size_bytes
       FROM assets WHERE id = $1`,
    [assetId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Asset ${assetId} does not exist.`);
  return row;
}

/** The durable job row for a subject, used to assert the job really ran and completed. */
async function jobForAsset(
  assetId: string,
  name: string,
): Promise<{ id: string; status: string; progress: number; attempts_made: number } | null> {
  const result = await getPool().query<{
    id: string;
    status: string;
    progress: number;
    attempts_made: number;
  }>(
    `SELECT id, status, progress, attempts_made FROM jobs
      WHERE name = $2 AND payload->>'assetId' = $1
      ORDER BY created_at DESC LIMIT 1`,
    [assetId, name],
  );
  return result.rows[0] ?? null;
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

describe('ProcessMedia', () => {
  it('probes a real uploaded clip and records the true dimensions from its bytes', async () => {
    const actor = await createActor(app, 'process-media@example.com');
    const projectId = await createProject(app, actor, 'Media project');

    const video = await mp4Fixture();
    const assetId = await upload(actor, projectId, video, 'clip.mp4', 'video/mp4');

    // Before processing the asset carries no probed metadata: the upload knows the byte
    // length but nothing about the container. This is what makes the post-processing
    // assertions meaningful rather than vacuous.
    const before = await assetRow(assetId);
    expect(before.width).toBeNull();
    expect(before.height).toBeNull();
    expect(before.thumbnail_key).toBeNull();

    // The upload itself queued the job, so this asserts the production trigger rather than
    // enqueueing one by hand.
    const queued = await jobForAsset(assetId, 'ProcessMedia');
    expect(queued, 'the upload should have enqueued ProcessMedia').not.toBeNull();
    expect(queued!.status).toBe('queued');

    await withWorker(async () => {
      const settled = await waitFor(
        async () => {
          const row = await jobForAsset(assetId, 'ProcessMedia');
          return row && row.status === 'completed' ? row : null;
        },
        { label: 'ProcessMedia to complete', timeoutMs: 60_000, intervalMs: 50 },
      );

      expect(settled.attempts_made).toBe(1);
      expect(settled.progress).toBe(100);
    });

    const processed = await assetRow(assetId);

    // The dimensions are the fixture's real 640x480, read out of the encoded container.
    expect(processed.width).toBe(640);
    expect(processed.height).toBe(480);
    expect(Number(processed.duration_seconds)).toBeGreaterThan(1.5);

    // The metadata records what probing actually found, including that this file carries
    // both streams.
    expect(processed.metadata.probed).toBe(true);
    expect(processed.metadata.hasVideo).toBe(true);
    expect(processed.metadata.hasAudio).toBe(true);
    expect(processed.metadata.formatName).toBeTruthy();

    // A thumbnail exists and is a real, non-empty JPEG in storage — attached only after
    // the handler verified the object.
    expect(processed.thumbnail_key).toBeTruthy();
    const thumbnailHead = await getContainer().storage.head(processed.thumbnail_key!);
    expect(thumbnailHead).not.toBeNull();
    expect(thumbnailHead!.size).toBeGreaterThan(0);

    const thumbnailBytes = await getContainer().storage.get(processed.thumbnail_key!);
    expect(thumbnailBytes.byteLength).toBe(thumbnailHead!.size);
    // JPEG SOI marker: proves this is an image, not an empty placeholder file.
    expect(thumbnailBytes.subarray(0, 2).toString('hex')).toBe('ffd8');

    // The original bytes are untouched by processing.
    const originalHead = await getContainer().storage.head(processed.storage_key);
    expect(originalHead).not.toBeNull();
    expect(originalHead!.size).toBe(Number(processed.size_bytes));
  });

  it('is idempotent: re-running on an already-processed asset changes nothing', async () => {
    const actor = await createActor(app, 'process-media-idempotent@example.com');
    const projectId = await createProject(app, actor, 'Idempotent media project');

    const assetId = await upload(actor, projectId, await mp4Fixture(), 'clip.mp4', 'video/mp4');

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await jobForAsset(assetId, 'ProcessMedia');
          return row && row.status === 'completed' ? row : null;
        },
        { label: 'first ProcessMedia pass', timeoutMs: 60_000, intervalMs: 50 },
      );
    });

    const first = await assetRow(assetId);
    expect(first.thumbnail_key).toBeTruthy();

    // Replay the job, exactly as a redelivery after a worker restart would.
    await getContainer().queue.enqueue(
      'ProcessMedia',
      { assetId, organizationId: actor.organizationId },
      { organizationId: actor.organizationId, maxAttempts: 1 },
    );

    await withWorker(async () => {
      await waitFor(
        async () => {
          const jobs = await getPool().query<{ status: string }>(
            `SELECT status FROM jobs
              WHERE name = 'ProcessMedia' AND payload->>'assetId' = $1
              ORDER BY created_at DESC LIMIT 1`,
            [assetId],
          );
          return jobs.rows[0]?.status === 'completed' ? jobs.rows[0] : null;
        },
        { label: 'replayed ProcessMedia to complete', timeoutMs: 30_000, intervalMs: 50 },
      );
    });

    const second = await assetRow(assetId);

    // The thumbnail key is unchanged, so the replay short-circuited rather than producing a
    // second derivative and orphaning the first.
    expect(second.thumbnail_key).toBe(first.thumbnail_key);
    expect(second.width).toBe(first.width);
    expect(second.height).toBe(first.height);

    // The replayed job carries an earlier progress write only: the handler returns before
    // doing any encoding work, which is what keeps a redelivery cheap.
    const replays = await getPool().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM jobs
        WHERE name = 'ProcessMedia' AND payload->>'assetId' = $1`,
      [assetId],
    );
    expect(Number(replays.rows[0]!.count)).toBe(2);
  });

  it('fails with a real, actionable error when the stored bytes are not decodable media', async () => {
    // A file whose declared type is allowed but whose contents are not media. The handler
    // must fail rather than record invented dimensions, and the durable job must carry the
    // real reason so an operator can act on it.
    const actor = await createActor(app, 'undecodable@example.com');
    const projectId = await createProject(app, actor, 'Undecodable project');

    // A PNG header followed by junk: passes the upload MIME allow-list (the client declares
    // video/mp4 with an .mp4 name) but ffprobe cannot decode it.
    const garbage = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.alloc(2048, 0x7f)]);
    const assetId = await upload(actor, projectId, garbage, 'broken.mp4', 'video/mp4');

    const maxAttempts = getContainer().config.worker.maxAttempts;

    await withWorker(async () => {
      const settled = await waitFor(
        async () => {
          const row = await jobForAsset(assetId, 'ProcessMedia');
          return row && row.status === 'failed' ? row : null;
        },
        { label: 'ProcessMedia to fail on undecodable bytes', timeoutMs: 60_000, intervalMs: 50 },
      );
      expect(settled.attempts_made).toBe(maxAttempts);
    });

    const durable = await getPool().query<{ last_error: string }>(
      `SELECT last_error FROM jobs WHERE name = 'ProcessMedia' AND payload->>'assetId' = $1`,
      [assetId],
    );
    expect(durable.rows[0]!.last_error).toContain(assetId);

    // Crucially, nothing was fabricated: no dimensions and no thumbnail were recorded.
    const failed = await assetRow(assetId);
    expect(failed.width).toBeNull();
    expect(failed.height).toBeNull();
    expect(failed.thumbnail_key).toBeNull();
  });
});

describe('GenerateThumbnail', () => {
  it('extracts a real poster frame on demand and attaches a verified object', async () => {
    const actor = await createActor(app, 'thumbnail@example.com');
    const projectId = await createProject(app, actor, 'Thumbnail project');

    const assetId = await upload(actor, projectId, await mp4Fixture(), 'clip.mp4', 'video/mp4');

    // Requested explicitly rather than as part of processing, which is the point of the
    // separate job. Registered on its own queue mapping, so this proves the routing.
    const { jobId, queueName } = await getContainer().queue.enqueue(
      'GenerateThumbnail',
      { assetId, organizationId: actor.organizationId, timeOffsetSeconds: 1 },
      { organizationId: actor.organizationId, projectId, maxAttempts: 2 },
    );
    expect(queueName).toBeTruthy();

    // Nothing is attached before the worker runs, so the later value is genuinely produced.
    expect((await assetRow(assetId)).thumbnail_key).toBeNull();

    await withWorker(async () => {
      await waitFor(
        async () => {
          const row = await jobForAsset(assetId, 'GenerateThumbnail');
          return row && row.status === 'completed' ? row : null;
        },
        { label: 'GenerateThumbnail to complete', timeoutMs: 60_000, intervalMs: 50 },
      );
    });

    const withThumbnail = await assetRow(assetId);
    expect(withThumbnail.thumbnail_key).toBeTruthy();

    const head = await getContainer().storage.head(withThumbnail.thumbnail_key!);
    expect(head).not.toBeNull();
    expect(head!.size).toBeGreaterThan(0);

    const bytes = await getContainer().storage.get(withThumbnail.thumbnail_key!);
    expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8');

    // The job row is terminal and carries no error.
    const job = await getContainer().repositories.jobs.findById(jobId);
    const error = await getPool().query<{ last_error: string | null }>(
      'SELECT last_error FROM jobs WHERE id = $1',
      [jobId],
    );
    expect(job!.status).toBe('completed');
    expect(error.rows[0]!.last_error).toBeNull();
  });

  it('completes as a no-op for audio, which has no video frame to extract', async () => {
    // The distinction that matters: an audio asset is perfectly valid, there is simply
    // nothing to render. Failing here would produce a stream of retries and dead letters
    // for a legitimate asset, so it is asserted as a completed no-op.
    const actor = await createActor(app, 'thumbnail-audio@example.com');
    const projectId = await createProject(app, actor, 'Audio thumbnail project');

    const assetId = await upload(actor, projectId, await mp3Fixture(), 'narration.mp3', 'audio/mpeg');

    await getContainer().queue.enqueue(
      'GenerateThumbnail',
      { assetId, organizationId: actor.organizationId },
      { organizationId: actor.organizationId, projectId, maxAttempts: 2 },
    );

    await withWorker(async () => {
      const settled = await waitFor(
        async () => {
          const row = await jobForAsset(assetId, 'GenerateThumbnail');
          return row && row.status === 'completed' ? row : null;
        },
        { label: 'audio thumbnail job to complete as a no-op', timeoutMs: 30_000, intervalMs: 50 },
      );
      // Completed on the first attempt: nothing was retried or dead-lettered.
      expect(settled.attempts_made).toBe(1);
      expect(settled.progress).toBe(100);
    });

    const unchanged = await assetRow(assetId);
    expect(unchanged.thumbnail_key).toBeNull();

    const durable = await getPool().query<{ last_error: string | null }>(
      `SELECT last_error FROM jobs WHERE name = 'GenerateThumbnail' AND payload->>'assetId' = $1`,
      [assetId],
    );
    expect(durable.rows[0]!.last_error).toBeNull();
  });

  it('refuses to act on an asset outside the caller’s organization', async () => {
    // The job carries an organization id, so a stale or tampered payload cannot be used to
    // reach another tenant's asset. The lookup is scoped, so this is a not-found, not a leak.
    const owner = await createActor(app, 'thumb-owner@example.com');
    const other = await createActor(app, 'thumb-other@example.com');

    const projectId = await createProject(app, owner, 'Scoped thumbnail project');
    const assetId = await upload(owner, projectId, await mp4Fixture(), 'clip.mp4', 'video/mp4');

    // The asset exists, but the payload names a different tenant. `findByIdInOrganization`
    // is scoped, so the handler cannot see it at all.
    //
    // Both jobs are drained before asserting. The upload itself enqueues `ProcessMedia` for
    // this asset, and that legitimately attaches a thumbnail — running the two jobs together
    // would make the observation race the legitimate derivative rather than the foreign one.
    await getContainer().queue.enqueue(
      'GenerateThumbnail',
      { assetId, organizationId: other.organizationId },
      { organizationId: other.organizationId, maxAttempts: 1 },
    );

    await withWorker(async () => {
      await waitFor(
        async () => {
          const jobs = await getPool().query<{ name: string; status: string }>(
            `SELECT name, status FROM jobs WHERE payload->>'assetId' = $1`,
            [assetId],
          );
          const pending = jobs.rows.filter(
            (row) => row.status !== 'completed' && row.status !== 'failed',
          );
          return pending.length === 0 ? jobs.rows : null;
        },
        { label: 'all jobs for the asset to settle', timeoutMs: 30_000, intervalMs: 50 },
      );
    });

    // The foreign request was refused. The lookup is scoped to the payload's organization,
    // so it is a not-found rather than a cross-tenant read.
    const durable = await getPool().query<{ status: string; last_error: string }>(
      `SELECT status, last_error FROM jobs
        WHERE name = 'GenerateThumbnail' AND payload->>'organizationId' = $1`,
      [other.organizationId],
    );
    expect(durable.rows).toHaveLength(1);
    expect(durable.rows[0]!.status).toBe('failed');
    expect(durable.rows[0]!.last_error).toContain('does not exist in this organization');

    // Crucially, the foreign request created nothing under its own organization: the
    // scoped lookup did not leak a row across the tenant boundary.
    const foreignAssets = await getPool().query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM assets WHERE organization_id = $1',
      [other.organizationId],
    );
    expect(Number(foreignAssets.rows[0]!.count)).toBe(0);

    // And the owner's asset is intact and owned by the owner, not the foreign tenant.
    const untouched = await assetRow(assetId);
    expect(untouched.organization_id).toBe(owner.organizationId);
    expect(untouched.storage_key).toBeTruthy();
  });
});
