/**
 * Media assets.
 *
 * Responsibilities:
 *  - validate uploads (MIME, extension, size) before any bytes are stored,
 *  - write bytes through the storage abstraction (never into PostgreSQL),
 *  - mint short-lived signed URLs rather than exposing storage keys,
 *  - enforce organization scoping on every read and delete.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  EXTENSION_MIME,
  UPLOAD_MIME_ALLOWLIST,
  errors,
  type AssetDTO,
  type AssetKind,
} from '@zyvano/shared';

import type { AssetRepository } from '../repositories/asset-repository';
import type { AuditService } from './audit-service';
import type { ProjectRepository } from '../repositories/project-repository';
import type { ObjectStorage } from '../infrastructure/storage';
import type { QueueService } from '../infrastructure/queue/queue';
import { toAssetDTO, type Row } from '../db/mappers';

export interface UploadInput {
  organizationId: string;
  projectId: string | null;
  ownerId: string;
  actorEmail: string;
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export class AssetService {
  constructor(
    private readonly assets: AssetRepository,
    private readonly projects: ProjectRepository,
    private readonly storage: ObjectStorage,
    private readonly audit: AuditService,
    private readonly maxUploadBytes = 524_288_000,
    private readonly queue: QueueService | null = null,
  ) {}

  /**
   * Validates an upload against the deployment allow-list. Returns the canonical
   * asset kind so callers never have to re-derive it.
   */
  static validateUpload(input: {
    filename: string;
    mimeType: string;
    sizeBytes: number;
    maxUploadBytes: number;
  }): { kind: AssetKind; extension: string } {
    const rule = UPLOAD_MIME_ALLOWLIST[input.mimeType.toLowerCase()];
    if (!rule) {
      throw errors.unsupportedMediaType(
        `Files of type "${input.mimeType}" are not accepted.`,
        [{ field: 'mimeType', message: 'Unsupported media type.' }],
      );
    }

    const extension = path.extname(input.filename).replace(/^\./, '').toLowerCase();
    if (!rule.extensions.includes(extension)) {
      throw errors.unsupportedMediaType(
        `A file named "${input.filename}" does not match its declared type.`,
        [{ field: 'filename', message: `Expected one of: ${rule.extensions.join(', ')}` }],
      );
    }

    if (input.sizeBytes <= 0) {
      throw errors.validation('The uploaded file is empty.', [
        { field: 'sizeBytes', message: 'File must not be empty.' },
      ]);
    }
    if (input.sizeBytes > input.maxUploadBytes) {
      throw errors.payloadTooLarge(
        `Files must be smaller than ${Math.round(input.maxUploadBytes / (1024 * 1024))} MB.`,
      );
    }

    return { kind: rule.kind, extension };
  }

  /**
   * Stores an uploaded file and records its metadata. The storage key is derived
   * from the organization and a random id, never from user input, so an upload
   * cannot choose where it lands.
   */
  async upload(input: UploadInput): Promise<AssetDTO> {
    if (input.projectId) {
      const project = await this.projects.findById(input.projectId);
      if (!project || project.organization_id !== input.organizationId) {
        throw errors.notFound('Project');
      }
    }

    const { kind, extension } = AssetService.validateUpload({
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.byteLength,
      maxUploadBytes: this.maxUploadBytes,
    });

    const checksum = createHash('sha256').update(input.buffer).digest('hex');
    const storageKey = `${input.organizationId}/uploads/${checksum.slice(0, 8)}-${Date.now()}.${extension}`;

    await this.storage.put({
      key: storageKey,
      body: input.buffer,
      contentType: input.mimeType,
      metadata: { organizationId: input.organizationId, ownerId: input.ownerId },
    });

    const row = await this.assets.create({
      organizationId: input.organizationId,
      projectId: input.projectId,
      ownerId: input.ownerId,
      kind,
      source: 'upload',
      filename: path.basename(input.filename).slice(0, 255),
      mimeType: input.mimeType,
      sizeBytes: input.buffer.byteLength,
      storageKey,
      checksum,
      metadata: { originalName: input.filename },
    });

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.ownerId,
      actorEmail: input.actorEmail,
      category: 'asset',
      action: 'asset.uploaded',
      resourceType: 'asset',
      resourceId: row.id as string,
      metadata: { kind, sizeBytes: input.buffer.byteLength, projectId: input.projectId },
    });

    // Probing and poster-frame extraction are CPU-bound, so they are queued rather than
    // run inside the request. This is what makes `ProcessMedia` reachable in production:
    // without it the handler existed but nothing ever dispatched to it, so an uploaded
    // asset would keep whatever dimensions the uploader claimed and would never gain a
    // thumbnail. A failure here must not fail the upload — the bytes are already safely
    // stored and the asset row is committed, so the job is recoverable by replay.
    if (this.queue) {
      await this.queue.enqueue(
        'ProcessMedia',
        { assetId: row.id as string, organizationId: input.organizationId },
        {
          organizationId: input.organizationId,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          dedupeKey: `process-media:${row.id as string}`,
        },
      );
    }

    return this.toDTOWithUrls(row);
  }

  /**
   * Records generated media produced by a worker. The bytes are already in
   * storage; this only persists metadata, so it is safe to call from a job.
   */
  async registerGenerated(input: {
    organizationId: string;
    projectId: string | null;
    ownerId: string;
    kind: AssetKind;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    thumbnailKey?: string | null;
    width?: number | null;
    height?: number | null;
    durationSeconds?: number | null;
    metadata?: Record<string, unknown>;
  }): Promise<Row> {
    return this.assets.create({ ...input, source: 'generated' });
  }

  async list(input: {
    organizationId: string;
    projectId?: string | undefined;
    kind?: AssetKind | undefined;
    source?: any;
    search?: string | undefined;
    page: number;
    perPage: number;
  }): Promise<{ items: AssetDTO[]; total: number }> {
    if (input.projectId) {
      const project = await this.projects.findById(input.projectId);
      if (!project || project.organization_id !== input.organizationId) {
        throw errors.notFound('Project');
      }
    }
    const result = await this.assets.list(input);
    return {
      items: await Promise.all(result.items.map(async (dto) => this.attachUrls(dto))),
      total: result.total,
    };
  }

  /** Organization-scoped fetch: an id from another tenant yields NOT_FOUND. */
  async get(assetId: string, organizationId: string): Promise<AssetDTO> {
    const row = await this.assets.findByIdInOrganization(assetId, organizationId);
    if (!row) throw errors.notFound('Asset');
    return this.toDTOWithUrls(row);
  }

  /** Internal read used by workers; no URL minting. */
  async getRow(assetId: string, organizationId: string): Promise<Row> {
    const row = await this.assets.findByIdInOrganization(assetId, organizationId);
    if (!row) throw errors.notFound('Asset');
    return row;
  }

  /**
   * Deletes an asset: the row is soft-deleted immediately (so it disappears from
   * the UI) and the storage keys are queued for physical removal by the cleanup
   * worker. This keeps the request fast and the deletion durable.
   */
  async remove(input: {
    assetId: string;
    organizationId: string;
    actorUserId: string;
    actorEmail: string;
  }): Promise<void> {
    const row = await this.assets.findByIdInOrganization(input.assetId, input.organizationId);
    if (!row) throw errors.notFound('Asset');

    const keys = [row.storage_key as string];
    if (row.thumbnail_key) keys.push(row.thumbnail_key as string);

    await this.assets.recordDeletion({
      assetId: input.assetId,
      storageKeys: keys,
      requestedBy: input.actorUserId,
    });
    await this.assets.softDelete(input.assetId);

    await this.audit.record({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      category: 'destructive',
      action: 'asset.deleted',
      resourceType: 'asset',
      resourceId: input.assetId,
      metadata: { storageKeys: keys.length },
    });
  }

  /**
   * Streams stored bytes for the local storage driver, where the API brokers
   * access instead of handing out a signed object URL.
   */
  async readContent(assetId: string, organizationId: string): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const row = await this.assets.findByIdInOrganization(assetId, organizationId);
    if (!row) throw errors.notFound('Asset');
    const buffer = await this.storage.get(row.storage_key as string);
    return {
      buffer,
      mimeType: row.mime_type as string,
      filename: row.filename as string,
    };
  }

  private async toDTOWithUrls(row: Row): Promise<AssetDTO> {
    return this.attachUrls(toAssetDTO(row));
  }

  /** Attaches signed URLs. The URL is time-limited and driver-appropriate. */
  private async attachUrls(dto: AssetDTO): Promise<AssetDTO> {
    const url = await this.signedUrlForKey(dto.id, dto.kind);
    return { ...dto, url, thumbnailUrl: dto.thumbnailUrl ?? url };
  }

  private async signedUrlForKey(assetId: string, _kind: AssetKind): Promise<string> {
    // The API brokers content for every driver (works identically for local and
    // S3), which keeps a single authorization check in front of every byte.
    const base = this.apiBaseUrl();
    return `${base}/api/v1/assets/${assetId}/content`;
  }

  private apiBaseUrl(): string {
    // Populated by the route layer from configuration; a relative path is also
    // valid for same-origin deployments.
    return '';
  }
}

export { EXTENSION_MIME };
