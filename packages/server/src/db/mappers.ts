/**
 * Row -> DTO mappers.
 *
 * The database uses snake_case and numeric/Date types; the API speaks camelCase
 * with ISO strings. All conversions live here so a column rename only has to be
 * reflected in one place.
 */
import type {
  AssetDTO,
  AuditEventDTO,
  ExportDTO,
  ExportFileDTO,
  GenerationAttemptDTO,
  GenerationDTO,
  JobDTO,
  NotificationDTO,
  OrganizationDTO,
  ProjectDTO,
  SceneDTO,
  ScriptDTO,
  StoryboardDTO,
  TemplateDTO,
  UsageRecordDTO,
  UserDTO,
} from '@zyvano/shared';

export type Row = Record<string, any>;

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requiredIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toUserDTO(row: Row): UserDTO {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    emailVerified: Boolean(row.email_verified_at),
    avatarUrl: row.avatar_url ?? null,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

export function toOrganizationDTO(row: Row): OrganizationDTO {
  const dto: OrganizationDTO = {
    id: row.id,
    name: row.name,
    slug: row.slug,
    ownerId: row.owner_id,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
  if (row.role) dto.role = row.role;
  if (row.member_count !== undefined && row.member_count !== null) {
    dto.memberCount = Number(row.member_count);
  }
  return dto;
}

export function toProjectDTO(row: Row): ProjectDTO {
  const dto: ProjectDTO = {
    id: row.id,
    organizationId: row.organization_id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description ?? null,
    prompt: row.prompt ?? null,
    status: row.status,
    aspectRatio: row.aspect_ratio,
    targetDurationSeconds: num(row.target_duration_seconds),
    thumbnailUrl: row.thumbnail_url ?? null,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };

  if (row.scene_count !== undefined || row.asset_count !== undefined) {
    dto.counts = {
      scenes: Number(row.scene_count ?? 0),
      assets: Number(row.asset_count ?? 0),
      generations: Number(row.generation_count ?? 0),
      exports: Number(row.export_count ?? 0),
    };
  }
  return dto;
}

export function toScriptDTO(row: Row): ScriptDTO {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    tone: row.tone ?? null,
    language: row.language,
    version: Number(row.version),
    sourceGenerationId: row.source_generation_id ?? null,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

export function toStoryboardDTO(row: Row): StoryboardDTO {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    shots: Array.isArray(row.shots) ? row.shots : [],
    sourceGenerationId: row.source_generation_id ?? null,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

export function toSceneDTO(row: Row): SceneDTO {
  return {
    id: row.id,
    projectId: row.project_id,
    orderIndex: Number(row.order_index),
    title: row.title,
    description: row.description ?? null,
    prompt: row.prompt ?? null,
    durationSeconds: num(row.duration_seconds) ?? 5,
    status: row.status,
    previewAssetId: row.preview_asset_id ?? null,
    previewUrl: row.preview_url ?? null,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

export function toAssetDTO(row: Row, urls: { url: string | null; thumbnailUrl: string | null } = { url: null, thumbnailUrl: null }): AssetDTO {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id ?? null,
    ownerId: row.owner_id,
    kind: row.kind,
    source: row.source,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    width: num(row.width),
    height: num(row.height),
    durationSeconds: num(row.duration_seconds),
    checksum: row.checksum ?? null,
    metadata: row.metadata ?? {},
    url: urls.url,
    thumbnailUrl: urls.thumbnailUrl,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

export function toGenerationAttemptDTO(row: Row): GenerationAttemptDTO {
  return {
    id: row.id,
    attemptNumber: Number(row.attempt_number),
    provider: row.provider,
    model: row.model ?? null,
    status: row.status,
    latencyMs: num(row.latency_ms),
    externalRequestId: row.external_request_id ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

export function toGenerationDTO(row: Row, urls: { outputUrl?: string | null } = {}): GenerationDTO {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    sceneId: row.scene_id ?? null,
    requestedBy: row.requested_by,
    kind: row.kind,
    capability: row.capability,
    provider: row.provider ?? null,
    model: row.model ?? null,
    status: row.status,
    progress: Number(row.progress ?? 0),
    prompt: row.prompt ?? null,
    parameters: row.parameters ?? {},
    result: row.result ?? null,
    outputAssetId: row.output_asset_id ?? null,
    outputUrl: urls.outputUrl ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    creditsUsed: Number(row.credits_used ?? 0),
    idempotencyKey: row.idempotency_key ?? null,
    createdAt: requiredIso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}

export function toExportFileDTO(row: Row, url: string | null): ExportFileDTO {
  return {
    id: row.id,
    assetId: row.asset_id,
    kind: row.kind,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    durationSeconds: num(row.duration_seconds),
    url,
    createdAt: requiredIso(row.created_at),
  };
}

export function toExportDTO(row: Row, files?: ExportFileDTO[]): ExportDTO {
  const dto: ExportDTO = {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    requestedBy: row.requested_by,
    status: row.status,
    progress: Number(row.progress ?? 0),
    preset: row.preset,
    format: row.format,
    resolution: row.resolution,
    includeAudio: Boolean(row.include_audio),
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    verified: Boolean(row.verified),
    expiresAt: iso(row.expires_at),
    createdAt: requiredIso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
  if (files) dto.files = files;
  return dto;
}

export function toTemplateDTO(row: Row): TemplateDTO {
  return {
    id: row.id,
    organizationId: row.organization_id ?? null,
    name: row.name,
    slug: row.slug,
    description: row.description ?? null,
    category: row.category,
    aspectRatio: row.aspect_ratio,
    defaultDurationSeconds: Number(row.default_duration_seconds),
    definition: row.definition ?? {},
    isSystem: Boolean(row.is_system),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  };
}

export function toUsageRecordDTO(row: Row): UsageRecordDTO {
  return {
    id: row.id,
    organizationId: row.organization_id,
    userId: row.user_id ?? null,
    projectId: row.project_id ?? null,
    capability: row.capability,
    provider: row.provider,
    units: Number(row.units ?? 0),
    credits: Number(row.credits ?? 0),
    createdAt: requiredIso(row.created_at),
  };
}

export function toAuditEventDTO(row: Row): AuditEventDTO {
  return {
    id: row.id,
    organizationId: row.organization_id ?? null,
    actorUserId: row.actor_user_id ?? null,
    actorEmail: row.actor_email ?? null,
    category: row.category,
    action: row.action,
    resourceType: row.resource_type ?? null,
    resourceId: row.resource_id ?? null,
    ipAddress: row.ip_address ?? null,
    requestId: row.request_id ?? null,
    metadata: row.metadata ?? {},
    createdAt: requiredIso(row.created_at),
  };
}

export function toNotificationDTO(row: Row): NotificationDTO {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body ?? null,
    resourceType: row.resource_type ?? null,
    resourceId: row.resource_id ?? null,
    readAt: iso(row.read_at),
    createdAt: requiredIso(row.created_at),
  };
}

export function toJobDTO(row: Row): JobDTO {
  return {
    id: row.id,
    queue: row.queue,
    name: row.name,
    status: row.status,
    attemptsMade: Number(row.attempts_made ?? 0),
    maxAttempts: Number(row.max_attempts ?? 5),
    progress: Number(row.progress ?? 0),
    organizationId: row.organization_id ?? null,
    projectId: row.project_id ?? null,
    generationId: row.generation_id ?? null,
    exportId: row.export_id ?? null,
    lastError: row.last_error ?? null,
    createdAt: requiredIso(row.created_at),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
  };
}
