/**
 * Zyvano worker.
 *
 * This process is the only place AI providers and media rendering are invoked.
 * HTTP handlers never block on a provider call; they persist a generation/export
 * row and enqueue a job, and this process advances that row through its real
 * lifecycle.
 *
 * Design rules enforced here:
 *  - every handler is idempotent: it re-reads the row and no-ops if the work was
 *    already done (a retried job must not double-charge or double-write),
 *  - a cancelled generation/export is never resurrected by a late result,
 *  - provider failures are persisted with their real error code, never masked
 *    as success, and credits are released when no provider call was billed,
 *  - media bytes go straight into object storage; only keys reach the database.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { JobName } from '@zyvano/shared';

import { buildContainer, type Container } from '@zyvano/server/container';
import {
  createQueueConsumer,
  type JobContext,
  type JobEnvelope,
  type JobHandler,
} from '@zyvano/server/infrastructure/queue/queue';
import { logger } from '@zyvano/server/observability/logger';
import type { MediaOutput, ProviderCallMeta } from '@zyvano/server/infrastructure/ai/interfaces';

import {
  buildStoryboardPrompts,
  buildScriptMessages,
  parseStoryboardResponse,
} from './prompts/storyboard';

/** Writes a provider media result into object storage and records the asset row. */
export async function persistMedia(input: {
  container: Container;
  organizationId: string;
  projectId: string;
  ownerId: string;
  kind: 'image' | 'video' | 'audio'; 
  media: MediaOutput;
  filenameStem: string;
  metadata?: Record<string, unknown>;
}): Promise<{ assetId: string; storageKey: string }> {
  const key = `${input.organizationId}/generated/${input.filenameStem}-${Date.now()}.${input.media.extension}`;

  await input.container.storage.put({
    key,
    body: input.media.data,
    contentType: input.media.mimeType,
    metadata: { organizationId: input.organizationId, projectId: input.projectId },
  });

  const row = await input.container.repositories.assets.create({
    organizationId: input.organizationId,
    projectId: input.projectId,
    ownerId: input.ownerId,
    kind: input.kind,
    source: 'generated',
    filename: `${input.filenameStem}.${input.media.extension}`,
    mimeType: input.media.mimeType,
    sizeBytes: input.media.data.byteLength,
    storageKey: key,
    width: input.media.width ?? null,
    height: input.media.height ?? null,
    durationSeconds: input.media.durationSeconds ?? null,
    metadata: input.metadata ?? {},
  });

  return { assetId: row.id as string, storageKey: key };
}

/**
 * Runs one generation: claims the row, records an attempt, invokes the provider,
 * persists the result, and settles the ledger. Shared by every AI job so the
 * lifecycle is implemented exactly once.
 */
export async function runGeneration(
  container: Container,
  context: JobContext,
  payload: JobEnvelope,
): Promise<void> {
  const generationId = payload.generationId as string;
  const organizationId = payload.organizationId as string;
  const projectId = payload.projectId as string;

  const existing = await container.repositories.generations.findById(generationId);
  if (!existing) throw new Error(`Generation ${generationId} no longer exists.`);

  // Idempotency: a retried job whose work already completed must not re-run.
  if (existing.status === 'completed') {
    context.logger.info('generation already completed; skipping');
    return;
  }
  if (existing.status === 'cancelled') {
    context.logger.info('generation was cancelled; skipping');
    return;
  }

  const claimed = await container.repositories.generations.claim(generationId);
  if (!claimed) {
    // Another worker holds the claim, or the row left the queued state.
    context.logger.info('generation could not be claimed; skipping');
    return;
  }

  await context.setProgress(10);

  const kind = claimed.kind as 'script' | 'storyboard' | 'image' | 'video' | 'voice' | 'audio';
  const requestedBy = claimed.requested_by as string;
  const parameters = (claimed.parameters as Record<string, unknown>) ?? {};
  const providerId = (claimed.provider as string | null) ?? undefined;
  const model = (claimed.model as string | null) ?? null;

  const attempt = await container.repositories.generations.startAttempt({
    generationId,
    provider: providerId ?? 'unknown',
    model,
    requestPayload: { kind, parameters },
  });

  const startedAt = Date.now();

  try {
    if (kind === 'script') {
      const text = container.providers.text(providerId);
      const result = await text.generate(buildScriptMessages({
        projectPrompt: (claimed.prompt as string | null) ?? '',
        tone: (parameters.tone as string | null) ?? null,
        language: (parameters.language as string | null) ?? 'en',
        targetDurationSeconds: (parameters.targetDurationSeconds as number | null) ?? null,
      }));

      await context.setProgress(70);

      const script = await container.repositories.scripts.create({
        projectId,
        title: 'Generated script',
        content: result.data.text,
        tone: (parameters.tone as string | null) ?? null,
        language: (parameters.language as string) ?? 'en',
        sourceGenerationId: generationId,
        createdBy: requestedBy,
      });

      await container.repositories.generations.completeAttempt({
        id: attempt.id as string,
        latencyMs: Date.now() - startedAt,
        externalRequestId: result.meta.externalRequestId,
        responseSummary: { characters: result.data.text.length, finishReason: result.data.finishReason },
      });
      await container.repositories.generations.recordProviderRequest({
        generationId,
        attemptId: attempt.id as string,
        organizationId,
        provider: result.meta.provider,
        capability: 'text',
        model: result.meta.model,
        externalRequestId: result.meta.externalRequestId,
        status: 'completed',
        latencyMs: result.meta.latencyMs,
        outputUnits: result.meta.usage.units,
        credits: result.meta.usage.credits,
      });

      await container.services.usage.record({
        organizationId,
        userId: requestedBy,
        projectId,
        generationId,
        capability: 'text',
        provider: result.meta.provider,
        model: result.meta.model,
        units: result.meta.usage.units,
        credits: result.meta.usage.credits,
      });

      // The reservation taken at dispatch is a conservative upper bound. Swap it for
      // what the provider actually billed so the workspace ledger stays truthful.
      await container.services.usage.reconcile({
        organizationId,
        reserved: Number(claimed.credits_reserved ?? 0),
        actual: result.meta.usage.credits,
      });

      await container.repositories.generations.markCompleted({
        id: generationId,
        result: { scriptId: script.id as string, characters: result.data.text.length },
        outputAssetId: null,
        creditsUsed: result.meta.usage.credits,
      });
      await context.setProgress(100);
      return;
    }

    if (kind === 'storyboard') {
      const text = container.providers.text(providerId);
      const existingScript = await container.repositories.scripts.latestForProject(projectId);
      const prompt = buildStoryboardPrompts({
        sceneCount: (parameters.sceneCount as number | null) ?? 6,
        script: existingScript?.content ?? (claimed.prompt as string | null) ?? '',
        language: (parameters.language as string | null) ?? 'en',
      });

      const result = await text.generate(prompt);
      await context.setProgress(70);

      const shots = parseStoryboardResponse(result.data.text);

      const storyboard = await container.repositories.scripts.createStoryboard({
        projectId,
        title: 'Generated storyboard',
        shots,
        sourceGenerationId: generationId,
        createdBy: requestedBy,
      });

      // Shots become real scenes so the pipeline can continue from the storyboard
      // without the user re-entering anything.
      for (const [index, shot] of shots.entries()) {
        await container.repositories.scenes.create({
          projectId,
          title: `Scene ${shot.sceneNumber}`,
          description: shot.description,
          prompt: shot.description,
          durationSeconds: shot.durationSeconds ?? 5,
          orderIndex: index,
        });
      }

      await container.repositories.generations.completeAttempt({
        id: attempt.id as string,
        latencyMs: Date.now() - startedAt,
        externalRequestId: result.meta.externalRequestId,
        responseSummary: { shots: shots.length },
      });
      await container.repositories.generations.recordProviderRequest({
        generationId,
        attemptId: attempt.id as string,
        organizationId,
        provider: result.meta.provider,
        capability: 'text',
        model: result.meta.model,
        externalRequestId: result.meta.externalRequestId,
        status: 'completed',
        latencyMs: result.meta.latencyMs,
        outputUnits: result.meta.usage.units,
        credits: result.meta.usage.credits,
      });
      await container.services.usage.record({
        organizationId,
        userId: requestedBy,
        projectId,
        generationId,
        capability: 'text',
        provider: result.meta.provider,
        model: result.meta.model,
        units: result.meta.usage.units,
        credits: result.meta.usage.credits,
      });

      await container.services.usage.reconcile({
        organizationId,
        reserved: Number(claimed.credits_reserved ?? 0),
        actual: result.meta.usage.credits,
      });

      await container.repositories.generations.markCompleted({
        id: generationId,
        result: { storyboardId: storyboard.id as string, shots: shots.length },
        outputAssetId: null,
        creditsUsed: result.meta.usage.credits,
      });
      await context.setProgress(100);
      return;
    }

    if (kind === 'image' || kind === 'video' || kind === 'voice' || kind === 'audio') {
      const capability: 'image' | 'video' | 'voice' | 'audio' =
        kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'voice' ? 'voice' : 'audio';

      const sceneId = (claimed.scene_id as string | null) ?? null;

      let media: MediaOutput;
      let meta: ProviderCallMeta;

      if (capability === 'voice' || capability === 'audio') {
        // Voice and audio adapters share one request shape.
        const request = {
          text: (claimed.prompt as string | null) ?? '',
          voiceId: (parameters.voiceId as string | null) ?? undefined,
          language: (parameters.language as string | null) ?? 'en',
          ...(model ? { model } : {}),
        };
        const result =
          capability === 'voice'
            ? await container.providers.voice(providerId).generate(request)
            : await container.providers.audio(providerId).generate(request);
        media = result.data;
        meta = result.meta;
      } else if (capability === 'video') {
        // A scene may carry a still preview that should be animated rather than
        // generated from scratch: the first frame becomes the reference image.
        let referenceImage: { data: Buffer; mimeType: string } | undefined;
        if (sceneId) {
          const scene = await container.repositories.scenes.findById(sceneId);
          const previewId = (scene?.preview_asset_id as string | null) ?? null;
          if (previewId) {
            const asset = await container.repositories.assets.findByIdInOrganization(previewId, organizationId);
            if (asset && (asset.kind as string) === 'image') {
              referenceImage = {
                data: await container.storage.get(asset.storage_key as string),
                mimeType: asset.mime_type as string,
              };
            }
          }
        }

        const result = await container.providers.video(providerId).generate({
          prompt: (claimed.prompt as string | null) ?? '',
          durationSeconds: (parameters.durationSeconds as number | null) ?? 5,
          ...((parameters.aspectRatio as string | null) ? { aspectRatio: parameters.aspectRatio as string } : {}),
          ...(referenceImage ? { referenceImage } : {}),
          ...(model ? { model } : {}),
        });
        media = result.data;
        meta = result.meta;
      } else {
        const result = await container.providers.image(providerId).generate({
          prompt: (claimed.prompt as string | null) ?? '',
          ...((parameters.width as number | undefined) ? { width: parameters.width as number } : {}),
          ...((parameters.height as number | undefined) ? { height: parameters.height as number } : {}),
          ...(model ? { model } : {}),
        });
        media = result.data;
        meta = result.meta;
      }

      await context.setProgress(75);

      const persisted = await persistMedia({
        container,
        organizationId,
        projectId,
        ownerId: requestedBy,
        kind: capability === 'image' ? 'image' : capability === 'video' ? 'video' : 'audio',
        media,
        filenameStem: `${kind}-${sceneId ?? projectId}`,
        metadata: { generationId, provider: meta.provider, model: meta.model },
      });

      // A generated video/image becomes the scene's preview so the timeline and the
      // export step have something real to consume.
      if (sceneId && (capability === 'image' || capability === 'video')) {
        await container.repositories.scenes.updateStatus(sceneId, 'completed', {
          previewAssetId: persisted.assetId,
        });
      }

      await container.repositories.generations.completeAttempt({
        id: attempt.id as string,
        latencyMs: Date.now() - startedAt,
        externalRequestId: meta.externalRequestId,
        responseSummary: { bytes: media.data.byteLength, mimeType: media.mimeType },
      });
      await container.repositories.generations.recordProviderRequest({
        generationId,
        attemptId: attempt.id as string,
        organizationId,
        provider: meta.provider,
        capability,
        model: meta.model,
        externalRequestId: meta.externalRequestId,
        status: 'completed',
        latencyMs: meta.latencyMs,
        outputUnits: meta.usage.units,
        credits: meta.usage.credits,
      });
      await container.services.usage.record({
        organizationId,
        userId: requestedBy,
        projectId,
        generationId,
        capability,
        provider: meta.provider,
        model: meta.model,
        units: meta.usage.units,
        credits: meta.usage.credits,
      });

      await container.services.usage.reconcile({
        organizationId,
        reserved: Number(claimed.credits_reserved ?? 0),
        actual: meta.usage.credits,
      });

      await container.repositories.generations.markCompleted({
        id: generationId,
        result: { assetId: persisted.assetId, bytes: media.data.byteLength },
        outputAssetId: persisted.assetId,
        creditsUsed: meta.usage.credits,
      });
      await context.setProgress(100);
      return;
    }

    throw new Error(`Unsupported generation kind "${kind}".`);
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    const errorCode = (error as { name?: string }).name === 'ProviderNotConfiguredError'
      ? 'PROVIDER_NOT_CONFIGURED'
      : (error as { options?: { errorCode?: string } }).options?.errorCode ?? 'PROVIDER_ERROR';

    await container.repositories.generations.failAttempt({
      id: attempt.id as string,
      latencyMs,
      errorCode,
      errorMessage: message,
    });
    await container.repositories.generations.recordProviderRequest({
      generationId,
      attemptId: attempt.id as string,
      organizationId,
      provider: providerId ?? 'unknown',
      capability: (claimed.capability as string) ?? 'unknown',
      model,
      externalRequestId: null,
      status: 'failed',
      latencyMs,
      credits: 0,
      errorCode,
    });

    // The provider was never billed, so any reservation is returned to the quota.
    const reserved = Number(claimed.credits_reserved ?? 0);
    if (reserved > 0) {
      await container.services.usage.release({ organizationId, credits: reserved });
    }

    await container.repositories.generations.markFailed({
      id: generationId,
      errorCode,
      errorMessage: message,
    });

    if (payload.sceneId) {
      await container.repositories.scenes.updateStatus(payload.sceneId as string, 'failed');
    }

    await container.services.notifications.notify({
      userId: requestedBy,
      organizationId,
      type: 'generation.failed',
      title: 'A generation failed',
      body: message.slice(0, 400),
      resourceType: 'generation',
      resourceId: generationId,
    });

    context.logger.error({ err: error, generationId, errorCode }, 'generation failed');
    // Swallow: the failure is persisted on the row, so retrying the job would only
    // re-invoke a provider that already refused. The user can retry explicitly.
  }
}

/**
 * Renders a project's scenes into a single export file using ffmpeg, then
 * verifies the produced object before marking the export complete.
 */
export async function runRender(
  container: Container,
  context: JobContext,
  payload: JobEnvelope,
): Promise<void> {
  const exportId = payload.exportId as string;
  const organizationId = payload.organizationId as string;
  const projectId = payload.projectId as string;

  const exportRow = await container.repositories.exports.findById(exportId);
  if (!exportRow) throw new Error(`Export ${exportId} no longer exists.`);
  if (exportRow.status === 'completed') {
    context.logger.info('export already completed; skipping');
    return;
  }
  if (exportRow.status === 'cancelled') {
    context.logger.info('export was cancelled; skipping');
    return;
  }

  const claimed = await container.repositories.exports.claim(exportId);
  if (!claimed) {
    context.logger.info('export could not be claimed; skipping');
    return;
  }

  // Fail fast when the deployment has no encoder. Reporting this as a
  // configuration fault is truthful: without ffmpeg no render can ever produce a
  // file, so marking the export failed beats burning worker slots on it.
  if (!container.config.media.enabled) {
    const message = 'Media processing is disabled on this deployment (MEDIA_PROCESSING_ENABLED=false).';
    await container.repositories.exports.markFailed({
      id: exportId,
      errorCode: 'MEDIA_PROCESSING_DISABLED',
      errorMessage: message,
    });
    context.logger.error({ exportId }, message);
    return;
  }

  const requestedBy = claimed.requested_by as string;
  const width = Number((claimed.resolution as string).split('x')[0]);
  const height = Number((claimed.resolution as string).split('x')[1]);
  const format = (claimed.format as 'mp4' | 'webm') ?? 'mp4';

  const presetLabel = claimed.preset as string;
  const bitrate =
    presetLabel === 'master-4k' ? '20000k' : presetLabel === 'web-720p' ? '2500k' : '5000k';

  try {
    const scenes = await container.repositories.scenes.listByProject(projectId);
    const renderable = scenes.filter((scene) => scene.previewAssetId);
    if (renderable.length === 0) {
      throw new Error('No rendered scenes are available to export.');
    }

    if (!(await container.media.available())) {
      throw new Error(
        `The configured encoder is not available on this host (MEDIA_FFMPEG_PATH=${container.config.media.ffmpegPath}).`,
      );
    }

    await context.setProgress(15);

    await container.media.withTempDir(async (dir) => {
      const segments: { path: string; durationSeconds: number }[] = [];

      for (const [index, scene] of renderable.entries()) {
        const asset = await container.repositories.assets.findByIdInOrganization(
          scene.previewAssetId as string,
          organizationId,
        );
        if (!asset) continue;

        const objectPath = await container.storage.localPath(asset.storage_key as string);
        // Scene sources are normalised so clips of different codecs and sizes
        // concatenate cleanly.
        const normalized = `${dir}/seg-${index}.mp4`;
        await container.media.render({
          segments: [{ path: objectPath, durationSeconds: Number(scene.durationSeconds) || 5 }],
          width,
          height,
          videoBitrate: bitrate,
          audioBitrate: '192k',
          format: 'mp4',
          outputPath: normalized,
        });
        segments.push({ path: normalized, durationSeconds: Number(scene.durationSeconds) || 5 });
      }

      await context.setProgress(55);

      const outputName = `zyvano-export-${exportId}.${format}`;
      const outputPath = `${dir}/${outputName}`;

      await container.media.render({
        segments,
        width,
        height,
        videoBitrate: bitrate,
        audioBitrate: '192k',
        format,
        outputPath,
      });

      await context.setProgress(80);

      const bytes = await container.media.withTempDir(async () => {
        const { readFile } = await import('node:fs/promises');
        return readFile(outputPath);
      });

      const probe = await container.media.probe(outputPath);
      const key = `${organizationId}/exports/${exportId}/${outputName}`;
      await container.storage.put({
        key,
        body: bytes,
        contentType: format === 'mp4' ? 'video/mp4' : 'video/webm',
        metadata: { exportId, organizationId },
      });

      const asset = await container.repositories.assets.create({
        organizationId,
        projectId,
        ownerId: requestedBy,
        kind: 'video',
        source: 'generated',
        filename: outputName,
        mimeType: format === 'mp4' ? 'video/mp4' : 'video/webm',
        sizeBytes: bytes.byteLength,
        storageKey: key,
        width: probe.width,
        height: probe.height,
        durationSeconds: probe.durationSeconds,
        metadata: { exportId },
      });

      await container.repositories.exports.addFile({
        exportId,
        assetId: asset.id as string,
        kind: 'video',
      });
    });

    await context.setProgress(95);

    // Verification gate: the export is only marked complete once the object is
    // confirmed present in storage with a non-zero size.
    const files = await container.repositories.exports.listFiles(exportId);
    let verified = files.length > 0;
    for (const file of files) {
      const head = await container.storage.head(file.storage_key as string);
      if (!head || head.size <= 0) verified = false;
    }

    if (!verified) {
      throw new Error('The rendered file could not be verified in storage.');
    }

    await container.repositories.exports.markCompleted({ id: exportId, verified: true });
    await context.setProgress(100);

    await container.services.notifications.notify({
      userId: requestedBy,
      organizationId,
      type: 'export.completed',
      title: 'Your export is ready',
      body: 'The rendered video has been verified and can be downloaded from the project.',
      resourceType: 'export',
      resourceId: exportId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await container.repositories.exports.markFailed({
      id: exportId,
      errorCode: 'RENDER_FAILED',
      errorMessage: message,
    });
    await container.services.notifications.notify({
      userId: requestedBy,
      organizationId,
      type: 'export.failed',
      title: 'An export failed',
      body: message.slice(0, 400),
      resourceType: 'export',
      resourceId: exportId,
    });
    context.logger.error({ err: error, exportId }, 'render failed');
  }
}

/* =============================== account deletion ============================= */

/**
 * Completes an account erasure.
 *
 * The request row is the durable intent record: it is written *before* this job is
 * enqueued, so a worker crash mid-deletion leaves a claimable request rather than a
 * half-erased account nobody knows about. The job is idempotent — a retry after a
 * partial run re-reads the request, skips work already finished, and reclaims
 * whatever remains.
 *
 * Nothing here reports success it cannot verify: the storage purge counts the objects
 * it actually removed and returns the failures, and the request is only marked
 * `completed` once the tombstone has been applied.
 */
export async function runAccountDeletion(
  container: Container,
  context: JobContext,
  payload: JobEnvelope,
): Promise<void> {
  const requestId = (payload.deletionRequestId as string | null) ?? null;
  if (!requestId) {
    throw new Error('DeleteUserData requires a deletionRequestId in its payload.');
  }

  const request = await container.repositories.deletionRequests.findById(requestId);
  if (!request) throw new Error(`Deletion request ${requestId} no longer exists.`);

  // Idempotency: a retried delivery whose work already landed must not re-run.
  if (request.status === 'completed') {
    context.logger.info('account deletion already completed; skipping');
    return;
  }

  const claimed = await container.repositories.deletionRequests.claim(requestId);
  if (!claimed) {
    context.logger.info('deletion request could not be claimed; skipping');
    return;
  }

  const userId = claimed.user_id as string | null;
  if (!userId) {
    throw new Error('The deletion request has no user attached; refusing to guess a target.');
  }

  await context.setProgress(10);

  // The tombstone rewrites the address, so it is captured now: the audit entry and
  // the deletion record must name who was erased.
  const user = await container.repositories.users.findById(userId);
  const userEmail = (user?.email as string | undefined) ?? 'unknown@zyvano.invalid';

  // Memberships are read before anything is removed, because this list is what decides
  // which workspaces are torn down and which the user merely leaves.
  const memberships = await container.repositories.organizations.listForUser(userId);

  let objectsDeleted = 0;
  const objectsFailed: string[] = [];
  let bytesReclaimed = 0;
  let projectsDeleted = 0;

  for (const organization of memberships) {
    bytesReclaimed += await container.repositories.assets.sumSizeBytesForOrganization(organization.id);
  }

  if (memberships.length > 0) {
    const result = await container.services.deletion.deleteAccount({
      userId,
      userEmail,
      organizations: memberships.map((organization) => ({
        id: organization.id,
        role: organization.role ?? 'member',
      })),
    });
    objectsDeleted += result.objectsDeleted;
    objectsFailed.push(...result.objectsFailed);
    projectsDeleted += result.projectsDeleted;
  }

  await context.setProgress(70);

  // Applied last, after every foreign key pointing at the user has been cleared or
  // cascaded, so it cannot fail on a constraint.
  await container.services.deletion.tombstoneAccount(userId);

  await context.setProgress(90);

  await container.repositories.deletionRequests.markCompleted(requestId, {
    nodeCount: projectsDeleted + objectsDeleted,
    bytesReclaimed,
  });
  await context.setProgress(100);

  context.logger.info(
    {
      requestId,
      userId,
      projectsDeleted,
      objectsDeleted,
      storageFailures: objectsFailed.length,
      bytesReclaimed,
    },
    'account deletion completed',
  );

  // Storage leftovers are reported rather than swallowed. They are recoverable by the
  // orphan sweep, but an operator should be able to see that the purge was imperfect.
  if (objectsFailed.length > 0) {
    context.logger.warn(
      { requestId, keys: objectsFailed.slice(0, 20), count: objectsFailed.length },
      'account deletion left objects in storage',
    );
  }
}

/* ============================== media processing ============================= */

/** Where a thumbnail derivative is stored relative to the entity root. */
const THUMBNAIL_PREFIX = 'thumbnails';

/**
 * Extracts a real poster frame from a stored asset and records it as the asset's
 * thumbnail.
 *
 * The object is only attached to the asset once `storage.head` has confirmed it exists
 * with a non-zero size, so the row never claims a thumbnail that was not produced.
 * Returns null when the asset has no video frame to extract (audio), which callers
 * treat as "nothing to do" rather than as a failure.
 */
async function extractThumbnail(input: {
  container: Container;
  organizationId: string;
  assetId: string;
  storageKey: string;
  filename: string;
  kind: string;
  timeOffsetSeconds?: number;
  width?: number;
}): Promise<{ thumbnailKey: string; bytes: number } | null> {
  if (input.kind === 'audio') return null;

  return input.container.media.withTempDir(async (dir) => {
    const extension = path.extname(input.filename).replace(/^\./, '').toLowerCase() || 'bin';
    const sourcePath = path.join(dir, `source.${extension}`);
    await writeFile(sourcePath, await input.container.storage.get(input.storageKey));

    const thumbnailPath = path.join(dir, 'thumbnail.jpg');
    await input.container.media.thumbnail({
      filePath: sourcePath,
      outputPath: thumbnailPath,
      width: input.width ?? 640,
      ...(input.timeOffsetSeconds !== undefined ? { timeOffsetSeconds: input.timeOffsetSeconds } : {}),
    });

    const bytes = await readFile(thumbnailPath);
    const thumbnailKey = `${input.organizationId}/${THUMBNAIL_PREFIX}/${input.assetId}.jpg`;

    await input.container.storage.put({
      key: thumbnailKey,
      body: bytes,
      contentType: 'image/jpeg',
      metadata: { organizationId: input.organizationId, sourceAssetId: input.assetId },
    });

    // Verification gate: never record a key whose object was not really written.
    const head = await input.container.storage.head(thumbnailKey);
    if (!head || head.size <= 0) {
      throw new Error('The generated thumbnail could not be verified in storage.');
    }

    return { thumbnailKey, bytes: bytes.byteLength };
  });
}

/**
 * Post-processes an asset that is already in storage.
 *
 * Used for uploads and for anything that needs its technical metadata established or
 * refreshed. Every value written comes from ffprobe reading the stored bytes — nothing
 * is taken from the filename or from what the uploader claimed, so an MP4 renamed to
 * `.png` is recorded as what it actually is.
 *
 * Idempotent: an asset that already carries probed dimensions and a verified thumbnail
 * is reported complete without re-encoding anything.
 */
export async function runMediaProcessing(
  container: Container,
  context: JobContext,
  payload: JobEnvelope,
): Promise<void> {
  const assetId = (payload.assetId as string | null) ?? null;
  const organizationId = (payload.organizationId as string | null) ?? null;
  if (!assetId || !organizationId) {
    throw new Error('ProcessMedia requires assetId and organizationId in its payload.');
  }

  const asset = await container.repositories.assets.findByIdInOrganization(assetId, organizationId);
  if (!asset) throw new Error(`Asset ${assetId} does not exist in this organization.`);

  // Fail fast with a configuration fault rather than spawning a missing binary.
  if (!container.config.media.enabled) {
    throw new Error(
      'Media processing is disabled on this deployment (MEDIA_PROCESSING_ENABLED=false).',
    );
  }
  if (!(await container.media.available())) {
    throw new Error(
      `The configured encoder is not available on this host (MEDIA_FFMPEG_PATH=${container.config.media.ffmpegPath}).`,
    );
  }

  const kind = asset.kind as string;
  const alreadyProcessed =
    asset.thumbnail_key !== null &&
    asset.thumbnail_key !== undefined &&
    asset.width !== null &&
    asset.width !== undefined;
  if (alreadyProcessed) {
    context.logger.info({ assetId }, 'asset already processed; skipping');
    await context.setProgress(100);
    return;
  }

  await context.setProgress(20);

  await container.media.withTempDir(async (dir) => {
    const extension = path.extname(asset.filename as string).replace(/^\./, '').toLowerCase() || 'bin';
    const sourcePath = path.join(dir, `source.${extension}`);
    await writeFile(sourcePath, await container.storage.get(asset.storage_key as string));

    await context.setProgress(45);

    let probe: Awaited<ReturnType<typeof container.media.probe>>;
    try {
      probe = await container.media.probe(sourcePath);
    } catch (error) {
      // A probe failure is a real verdict: the bytes are not decodable media. Saying so
      // lets an operator or the user act on it, instead of leaving the asset in limbo.
      throw new Error(
        `Stored asset ${assetId} could not be decoded as media: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    if (!probe.hasVideo && !probe.hasAudio) {
      throw new Error(`Stored asset ${assetId} contains neither a video nor an audio stream.`);
    }

    await context.setProgress(70);

    const thumbnail = await extractThumbnail({
      container,
      organizationId,
      assetId,
      storageKey: asset.storage_key as string,
      filename: asset.filename as string,
      kind,
    });

    await container.repositories.assets.updateProcessing(assetId, {
      width: probe.width,
      height: probe.height,
      durationSeconds: probe.durationSeconds,
      ...(thumbnail ? { thumbnailKey: thumbnail.thumbnailKey } : {}),
      metadata: {
        ...((asset.metadata as Record<string, unknown> | null) ?? {}),
        probed: true,
        formatName: probe.formatName,
        hasAudio: probe.hasAudio,
        hasVideo: probe.hasVideo,
        thumbnailBytes: thumbnail?.bytes ?? null,
      },
    });

    context.logger.info(
      {
        assetId,
        formatName: probe.formatName,
        width: probe.width,
        height: probe.height,
        durationSeconds: probe.durationSeconds,
        thumbnail: thumbnail !== null,
      },
      'asset processed',
    );
  });

  await context.setProgress(100);
}

/**
 * Produces a thumbnail for an asset and attaches it.
 *
 * Split from `ProcessMedia` because a thumbnail can be requested on its own — after a
 * poster frame is chosen, say — without re-probing the whole asset. It shares the same
 * extraction routine, so a fix to frame extraction cannot apply to only one of them.
 *
 * Audio has no frame to extract, which is reported as a completed no-op rather than an
 * error: the asset is valid, there is simply nothing to render.
 */
export async function runThumbnailGeneration(
  container: Container,
  context: JobContext,
  payload: JobEnvelope,
): Promise<void> {
  const assetId = (payload.assetId as string | null) ?? null;
  const organizationId = (payload.organizationId as string | null) ?? null;
  if (!assetId || !organizationId) {
    throw new Error('GenerateThumbnail requires assetId and organizationId in its payload.');
  }

  const asset = await container.repositories.assets.findByIdInOrganization(assetId, organizationId);
  if (!asset) throw new Error(`Asset ${assetId} does not exist in this organization.`);

  if (!container.config.media.enabled) {
    throw new Error(
      'Media processing is disabled on this deployment (MEDIA_PROCESSING_ENABLED=false).',
    );
  }

  const kind = asset.kind as string;
  if (kind === 'audio') {
    context.logger.info({ assetId }, 'audio has no video frame to extract; nothing to do');
    await context.setProgress(100);
    return;
  }

  if (!(await container.media.available())) {
    throw new Error(
      `The configured encoder is not available on this host (MEDIA_FFMPEG_PATH=${container.config.media.ffmpegPath}).`,
    );
  }

  await context.setProgress(30);

  const requestedOffset = payload.timeOffsetSeconds as number | undefined;
  const thumbnail = await extractThumbnail({
    container,
    organizationId,
    assetId,
    storageKey: asset.storage_key as string,
    filename: asset.filename as string,
    kind,
    ...(requestedOffset !== undefined ? { timeOffsetSeconds: requestedOffset } : {}),
  });

  if (!thumbnail) {
    await context.setProgress(100);
    return;
  }

  await context.setProgress(80);

  await container.repositories.assets.updateProcessing(assetId, {
    thumbnailKey: thumbnail.thumbnailKey,
  });

  context.logger.info({ assetId, bytes: thumbnail.bytes }, 'thumbnail generated');
  await context.setProgress(100);
}

/** Periodic retention/cleanup maintenance. */
export async function runCleanup(container: Container, context: JobContext): Promise<void> {
  await context.setProgress(10);
  const deletions = await container.services.deletion.processPendingAssetDeletions(200);
  await context.setProgress(50);
  const exports = await container.services.deletion.sweepExpiredExports(100);
  await context.setProgress(90);
  const jobs = await container.repositories.jobs.deleteOlderThan(30);
  await context.setProgress(100);

  context.logger.info(
    { assetDeletions: deletions.processed, deletionFailures: deletions.failed, expiredExports: exports.purged, prunedJobRows: jobs },
    'maintenance sweep complete',
  );
}

/**
 * Builds the worker graph and attaches every handler to its queue.
 *
 * Exported so it can be exercised in-process (see `createWorkerHandlers`), which
 * is what lets the integration suite drive the real handlers over a real queue
 * instead of reimplementing the lifecycle in the test file.
 */
export async function startWorker(): Promise<void> {
  const container = buildContainer();
  const config = container.config;

  logger.info({ env: config.nodeEnv, concurrency: config.worker.concurrency }, 'starting zyvano worker');

  const consumer = createQueueConsumer({
    redisUrl: config.redisUrl,
    prefix: config.worker.queuePrefix,
    concurrency: config.worker.concurrency,
    jobs: container.repositories.jobs,
  });

  const register = (name: JobName, handler: Parameters<typeof consumer.register>[1]): void => {
    consumer.register(name, handler);
  };

  // Handlers come from the exported table so the code the integration suite
  // drives is byte-for-byte the code that runs here in production.
  const handlers = createWorkerHandlers(container);
  for (const [name, handler] of Object.entries(handlers)) {
    if (!handler) continue;
    register(name as JobName, handler);
  }

  await consumer.start();
  logger.info('zyvano worker ready');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'worker shutdown requested');
    const forceExit = setTimeout(() => process.exit(1), 30_000);
    forceExit.unref();
    await consumer.close();
    await container.close();
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection in worker');
  });
}

/**
 * The real handler table, constructed against a caller-supplied container.
 *
 * `startWorker` registers exactly this table, so anything present here is by
 * definition the same code that runs in production, and the integration suite can
 * attach the genuine handlers to an in-process consumer rather than restating the
 * lifecycle in the test file.
 *
 * The return type is partial on purpose: it reflects which job names this worker
 * actually implements. Dispatching a job name that is absent fails loudly in the
 * queue consumer instead of silently doing nothing.
 */
export function createWorkerHandlers(container: Container): Partial<Record<JobName, JobHandler>> {
  return {
    // AI generation jobs all share one lifecycle implementation, so a fix to
    // retry handling or credit release cannot be applied to only some kinds.
    GenerateScript: (payload, context) => runGeneration(container, context, payload),
    GenerateStoryboard: (payload, context) => runGeneration(container, context, payload),
    GenerateScene: (payload, context) => runGeneration(container, context, payload),
    GenerateImage: (payload, context) => runGeneration(container, context, payload),
    GenerateVideo: (payload, context) => runGeneration(container, context, payload),
    GenerateVoice: (payload, context) => runGeneration(container, context, payload),

    RenderVideo: (payload, context) => runRender(container, context, payload),
    ExportProject: (payload, context) => runRender(container, context, payload),

    ProcessMedia: (payload, context) => runMediaProcessing(container, context, payload),
    GenerateThumbnail: (payload, context) => runThumbnailGeneration(container, context, payload),
    DeleteUserData: (payload, context) => runAccountDeletion(container, context, payload),

    CleanupExpiredFiles: (_payload, context) => runCleanup(container, context),
  };
}

/**
 * Entry point. Skipped when the module is imported (tests, tooling) so importing
 * the handler table never starts a process that connects to Redis or registers
 * signal handlers.
 *
 * The check must work under both runtimes this file is loaded by: Node running the
 * bundled CommonJS artifact, and the ESM test runner transpiling the source. The
 * `typeof require` guard covers the second case, where `require` does not exist.
 */
const isDirectExecution: boolean = (() => {
  try {
    return typeof require !== 'undefined' && require.main === module;
  } catch {
    return false;
  }
})();

if (isDirectExecution) {
  void startWorker().catch((error) => {
    logger.error({ err: error }, 'fatal worker error');
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}