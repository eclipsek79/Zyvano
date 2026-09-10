/**
 * Export orchestration.
 *
 * Creating an export only validates the request and enqueues a render. The export
 * is never reported as complete until the render worker has confirmed that every
 * output object exists in storage — `verified` gates the download endpoint.
 */
import {
  EXPORT_PRESET_TARGETS,
  EXPORT_PRESETS,
  JOB_NAMES,
  errors,
  type ExportDTO,
  type ExportPreset,
  type ExportStatus,
} from '@zyvano/shared';

import { toExportDTO, toExportFileDTO } from '../db/mappers';
import type { AppConfig } from '../config/env';
import type { QueueService } from '../infrastructure/queue/queue';
import type { ObjectStorage } from '../infrastructure/storage';
import type { AuditService } from './audit-service';
import type { AssetRepository } from '../repositories/asset-repository';
import type { ExportRepository } from '../repositories/export-repository';
import type { JobRepository } from '../repositories/job-repository';
import type { ProjectRepository } from '../repositories/project-repository';
import type { SceneRepository } from '../repositories/scene-repository';

export interface ExportServiceDeps {
  exports: ExportRepository;
  projects: ProjectRepository;
  scenes: SceneRepository;
  assets: AssetRepository;
  jobs: JobRepository;
  queue: QueueService;
  storage: ObjectStorage;
  audit: AuditService;
  config: AppConfig;
}

export class ExportService {
  constructor(private readonly deps: ExportServiceDeps) {}

  /**
   * Validates and queues a render.
   *
   * A project must have at least one scene with a completed video asset attached,
   * otherwise the render would produce an empty file. That check happens here so
   * the user is told immediately rather than after a failed job.
   */
  async create(input: {
    organizationId: string;
    projectId: string;
    requestedBy: string;
    preset: ExportPreset;
    includeAudio: boolean;
    format?: 'mp4' | 'webm' | undefined;
    idempotencyKey?: string | undefined;
  }): Promise<{ export: ExportDTO; deduplicated: boolean }> {
    const project = await this.deps.projects.findById(input.projectId);
    if (!project || project.organization_id !== input.organizationId) {
      throw errors.notFound('Project');
    }

    if (input.idempotencyKey) {
      const existing = await this.deps.exports.findByIdempotencyKey(
        input.organizationId,
        input.idempotencyKey,
      );
      if (existing) return { export: toExportDTO(existing), deduplicated: true };
    }

    if (!EXPORT_PRESETS.includes(input.preset)) {
      throw errors.validation('Unknown export preset.', [
        { field: 'preset', message: 'Unsupported preset.' },
      ]);
    }
    const target = EXPORT_PRESET_TARGETS[input.preset]!;
    const resolution = `${target.width}x${target.height}`;

    const scenes = await this.deps.scenes.listByProject(input.projectId);
    if (scenes.length === 0) {
      throw errors.validation(
        'This project has no scenes yet. Generate scenes before exporting.',
        [{ field: 'projectId', message: 'At least one scene is required.' }],
      );
    }

    const renderable = scenes.filter((scene) => scene.previewAssetId);
    if (renderable.length === 0) {
      throw errors.validation(
        'None of this project\'s scenes have rendered media yet. Generate at least one scene video before exporting.',
        [{ field: 'projectId', message: 'At least one rendered scene is required.' }],
      );
    }

    const expiresAt = new Date(
      Date.now() + this.deps.config.retention.exportRetentionDays * 24 * 60 * 60 * 1000,
    );

    const exportRow = await this.deps.exports.create({
      organizationId: input.organizationId,
      projectId: input.projectId,
      requestedBy: input.requestedBy,
      preset: input.preset,
      format: input.format ?? 'mp4',
      resolution,
      includeAudio: input.includeAudio,
      idempotencyKey: input.idempotencyKey ?? null,
      expiresAt,
    });

    try {
      await this.deps.queue.enqueue(
        JOB_NAMES.RENDER_VIDEO,
        {
          exportId: exportRow.id,
          organizationId: input.organizationId,
          projectId: input.projectId,
        },
        {
          organizationId: input.organizationId,
          projectId: input.projectId,
          exportId: exportRow.id as string,
          maxAttempts: this.deps.config.worker.maxAttempts,
        },
      );
    } catch (error) {
      await this.deps.exports.markFailed({
        id: exportRow.id as string,
        errorCode: 'QUEUE_UNAVAILABLE',
        errorMessage: error instanceof Error ? error.message : 'Job queue unavailable.',
      });
      throw errors.infrastructure('The render queue is unavailable. Please retry shortly.');
    }

    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.requestedBy,
      category: 'export',
      action: 'export.created',
      resourceType: 'export',
      resourceId: exportRow.id as string,
      metadata: { preset: input.preset, resolution },
    });

    return { export: toExportDTO(exportRow), deduplicated: false };
  }

  async list(input: {
    organizationId: string;
    projectId?: string | undefined;
    status?: ExportStatus | undefined;
    page: number;
    perPage: number;
  }): Promise<{ items: ExportDTO[]; total: number }> {
    if (input.projectId) {
      const project = await this.deps.projects.findById(input.projectId);
      if (!project || project.organization_id !== input.organizationId) {
        throw errors.notFound('Project');
      }
    }
    return this.deps.exports.list(input);
  }

  /** Returns the export with its files and freshly minted, time-limited URLs. */
  async get(input: { exportId: string; organizationId: string }): Promise<ExportDTO> {
    const row = await this.deps.exports.findByIdInOrganization(input.exportId, input.organizationId);
    if (!row) throw errors.notFound('Export');

    const fileRows = await this.deps.exports.listFiles(input.exportId);
    const files = await Promise.all(
      fileRows.map(async (file) => {
        const storageKey = file.storage_key as string;
        // A completed-but-unverified export gets no URLs: the client must never be
        // handed a link to a file that may not exist.
        const url =
          row.status === 'completed' && row.verified && (await this.deps.storage.exists(storageKey))
            ? await this.deps.storage.signedUrl(storageKey, {
                downloadFilename: file.filename as string,
              })
            : null;
        // Same translation the download gate applies: a driver without an HTTP origin
        // yields a marker rather than a fetchable URL, so it is replaced by this API's
        // byte-streaming endpoint. `url` stays null when the file is not ready, so the
        // client is never handed a link to something that may not exist.
        //
        // No `download` flag here: this URL is also used as a preview source, so it is
        // served inline. The dedicated download path asks for the attachment form.
        return toExportFileDTO(
          file,
          url === null ? null : this.publicDownloadUrl(url, input.exportId),
        );
      }),
    );

    return toExportDTO(row, files);
  }

  /**
   * Download gate. Returns a URL only when the export is completed, verified by
   * the worker, and the object is still present and unexpired.
   */
  async getDownload(input: {
    exportId: string;
    organizationId: string;
    actorUserId: string;
  }): Promise<{ url: string; filename: string; expiresAt: string | null }> {
    const row = await this.deps.exports.findByIdInOrganization(input.exportId, input.organizationId);
    if (!row) throw errors.notFound('Export');

    if (row.status !== 'completed') {
      throw errors.conflict(`This export is ${row.status} and has no downloadable file yet.`);
    }
    if (!row.verified) {
      throw errors.conflict('This export has not finished verification yet.');
    }
    if (row.expires_at && new Date(row.expires_at as Date) < new Date()) {
      throw errors.gone('This export has expired and its file was removed.');
    }

    const files = await this.deps.exports.listFiles(input.exportId);
    const primary = files.find((file) => file.kind === 'video') ?? files[0];
    if (!primary) throw errors.notFound('Export file');

    const storageKey = primary.storage_key as string;
    if (!(await this.deps.storage.exists(storageKey))) {
      // The row claims completion but the object is gone: report honestly and flag
      // the export so an operator can see the inconsistency.
      await this.deps.exports.markFailed({
        id: input.exportId,
        errorCode: 'FILE_MISSING',
        errorMessage: 'The rendered file is no longer present in storage.',
      });
      throw errors.gone('The rendered file is no longer available.');
    }

    const url = await this.deps.storage.signedUrl(storageKey, {
      downloadFilename: primary.filename as string,
    });

    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'export',
      action: 'export.downloaded',
      resourceType: 'export',
      resourceId: input.exportId,
    });

    return {
      url: this.publicDownloadUrl(url, input.exportId, { download: true }),
      filename: primary.filename as string,
      expiresAt: row.expires_at ? new Date(row.expires_at as Date).toISOString() : null,
    };
  }

  /**
   * Returns a URL an HTTP client can actually fetch.
   *
   * The S3 driver produces a presigned HTTPS URL that is already fetchable. The local
   * filesystem driver has no HTTP origin of its own, so its `signedUrl` yields a
   * `local://` marker that no browser can open. Handing that marker to a client made the
   * download button fail on any deployment using local storage, so it is translated into
   * this API's own byte-streaming endpoint instead — which re-checks authorization on
   * every request rather than trusting a key that was already handed out.
   *
   * `download` selects the attachment form of that endpoint. The same endpoint without it
   * serves the bytes inline, which is what a preview element needs.
   */
  private publicDownloadUrl(
    storageUrl: string,
    exportId: string,
    options: { download?: boolean } = {},
  ): string {
    const isFetchable = /^https?:\/\//i.test(storageUrl);
    if (isFetchable) return storageUrl;
    return `/api/v1/exports/${exportId}/file${options.download ? '?download=1' : ''}`;
  }

  /**
   * The download gate again, but for the byte stream rather than a URL.
   *
   * Used by `GET /exports/:id/file` so that deployments without a signed-URL origin
   * (the local driver) still serve the rendered file. The authorization and the
   * "is the file really there" checks are the same ones the URL path performs.
   */
  async readFile(input: {
    exportId: string;
    organizationId: string;
    actorUserId: string;
  }): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    // Runs the same gate the URL path uses: authorization, status, verification and
    // existence. Its return value is a URL, which this path does not need, but the
    // checks it performs are the point.
    await this.getDownload(input);
    const files = await this.deps.exports.listFiles(input.exportId);
    const primary = files.find((file) => file.kind === 'video') ?? files[0];
    if (!primary) throw errors.notFound('Export file');

    const storageKey = primary.storage_key as string;
    const buffer = await this.deps.storage.get(storageKey);
    if (buffer.byteLength === 0) {
      throw errors.gone('The rendered file is empty and cannot be served.');
    }

    return {
      buffer,
      mimeType: (primary.mime_type as string | null) ?? 'application/octet-stream',
      filename: primary.filename as string,
    };
  }

  async cancel(input: { exportId: string; organizationId: string; actorUserId: string }): Promise<ExportDTO> {
    const row = await this.deps.exports.findByIdInOrganization(input.exportId, input.organizationId);
    if (!row) throw errors.notFound('Export');
    const cancelled = await this.deps.exports.cancel(input.exportId);
    if (!cancelled) throw errors.conflict('This export has already finished.');

    await this.deps.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      category: 'export',
      action: 'export.cancelled',
      resourceType: 'export',
      resourceId: input.exportId,
    });
    return this.get({ exportId: input.exportId, organizationId: input.organizationId });
  }

  /** Re-runs a failed export as a new record. */
  async retry(input: { exportId: string; organizationId: string; actorUserId: string }): Promise<ExportDTO> {
    const row = await this.deps.exports.findByIdInOrganization(input.exportId, input.organizationId);
    if (!row) throw errors.notFound('Export');
    if (row.status !== 'failed' && row.status !== 'cancelled') {
      throw errors.conflict('Only failed or cancelled exports can be retried.');
    }
    const { export: created } = await this.create({
      organizationId: input.organizationId,
      projectId: row.project_id as string,
      requestedBy: input.actorUserId,
      preset: row.preset as ExportPreset,
      includeAudio: Boolean(row.include_audio),
      idempotencyKey: `retry:${input.exportId}:${Date.now()}`,
    });
    return created;
  }
}

export { toExportDTO };
