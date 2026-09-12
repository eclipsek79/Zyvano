/**
 * Zyvano shared domain contracts.
 *
 * These types are the single source of truth for the wire format between the
 * API, the worker processes and the web client. They intentionally contain no
 * runtime dependencies beyond plain TypeScript so they can be imported from any
 * workspace package.
 */

/* -------------------------------------------------------------------------- */
/* Roles, permissions, membership                                              */
/* -------------------------------------------------------------------------- */

export const ORG_ROLES = ['owner', 'admin', 'editor', 'member', 'viewer'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const PERMISSIONS = [
  'org:read',
  'org:update',
  'org:delete',
  'org:manage_members',
  'project:create',
  'project:read',
  'project:update',
  'project:delete',
  'project:manage_members',
  'asset:read',
  'asset:upload',
  'asset:delete',
  'generation:read',
  'generation:create',
  'generation:cancel',
  'export:read',
  'export:create',
  'export:delete',
  'template:read',
  'template:manage',
  'usage:read',
  'audit:read',
  'apikey:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Role -> permission grants. Ordered from most to least privileged. */
export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((p) => p !== 'org:delete'),
  editor: [
    'org:read',
    'project:create',
    'project:read',
    'project:update',
    'asset:read',
    'asset:upload',
    'asset:delete',
    'generation:read',
    'generation:create',
    'generation:cancel',
    'export:read',
    'export:create',
    'export:delete',
    'template:read',
    'usage:read',
  ],
  member: [
    'org:read',
    'project:create',
    'project:read',
    'project:update',
    'asset:read',
    'asset:upload',
    'generation:read',
    'generation:create',
    'export:read',
    'export:create',
    'template:read',
    'usage:read',
  ],
  viewer: ['org:read', 'project:read', 'asset:read', 'generation:read', 'export:read', 'template:read'],
};

/** Higher rank wins. Used for role-comparison guards. */
export const ROLE_RANK: Record<OrgRole, number> = {
  owner: 5,
  admin: 4,
  editor: 3,
  member: 2,
  viewer: 1,
};

/* -------------------------------------------------------------------------- */
/* Lifecycle states                                                            */
/* -------------------------------------------------------------------------- */

export const JOB_STATUSES = ['queued', 'processing', 'completed', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const GENERATION_STATUSES = JOB_STATUSES;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

export const EXPORT_STATUSES = JOB_STATUSES;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export type GenerationKind = 'script' | 'storyboard' | 'scene' | 'image' | 'video' | 'voice' | 'audio';

export const PROJECT_STATUSES = ['draft', 'active', 'rendering', 'completed', 'archived', 'deleted'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const ASSET_KINDS = ['image', 'video', 'audio', 'document', 'other'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export const ASSET_SOURCES = ['upload', 'generated', 'system'] as const;
export type AssetSource = (typeof ASSET_SOURCES)[number];

/**
 * Export preset identifiers. The encoding targets for each preset live in
 * `constants.ts` (EXPORT_PRESET_TARGETS); this union is the single source of
 * truth for the identifier names, and validation.ts is type-checked against it.
 */
export type ExportPreset =
  | 'web-720p'
  | 'web-1080p'
  | 'social-vertical'
  | 'social-square'
  | 'master-4k';

export const AUDIT_CATEGORIES = [
  'auth',
  'authorization',
  'project',
  'generation',
  'export',
  'asset',
  'destructive',
  'admin',
  'system',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/* -------------------------------------------------------------------------- */
/* Provider abstraction                                                        */
/* -------------------------------------------------------------------------- */

export const AI_CAPABILITIES = ['text', 'image', 'video', 'audio', 'voice'] as const;
export type AICapability = (typeof AI_CAPABILITIES)[number];

export interface ProviderDescriptor {
  /** Stable provider slug, e.g. "openai". */
  id: string;
  /** Human readable name. */
  label: string;
  capabilities: readonly AICapability[];
  /** False when the deployment is missing the credentials this provider needs. */
  configured: boolean;
  /** Names of the environment variables required to configure the provider. */
  requiredEnv: readonly string[];
}

/* -------------------------------------------------------------------------- */
/* Wire DTOs                                                                   */
/* -------------------------------------------------------------------------- */

export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationDTO {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  /** Role of the requesting user inside this organization. */
  role?: OrgRole;
  memberCount?: number;
}

export interface ProjectMemberDTO {
  userId: string;
  email: string;
  displayName: string;
  role: OrgRole;
  addedAt: string;
}

export interface ProjectDTO {
  id: string;
  organizationId: string;
  ownerId: string;
  name: string;
  description: string | null;
  /** The creative prompt that drives the generation pipeline. */
  prompt: string | null;
  status: ProjectStatus;
  aspectRatio: string;
  targetDurationSeconds: number | null;
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
  /** Present when the project was requested with aggregate counts. */
  counts?: {
    scenes: number;
    assets: number;
    generations: number;
    exports: number;
  };
}

export interface ScriptDTO {
  id: string;
  projectId: string;
  title: string;
  content: string;
  tone: string | null;
  language: string;
  version: number;
  sourceGenerationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardShot {
  sceneNumber: number;
  description: string;
  cameraAngle?: string;
  durationSeconds?: number;
}

export interface StoryboardDTO {
  id: string;
  projectId: string;
  title: string;
  shots: StoryboardShot[];
  sourceGenerationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SceneDTO {
  id: string;
  projectId: string;
  orderIndex: number;
  title: string;
  description: string | null;
  /** Prompt handed to the video/image provider for this scene. */
  prompt: string | null;
  durationSeconds: number;
  status: GenerationStatus;
  previewAssetId: string | null;
  previewUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AssetDTO {
  id: string;
  organizationId: string;
  projectId: string | null;
  ownerId: string;
  kind: AssetKind;
  source: AssetSource;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  checksum: string | null;
  metadata: Record<string, unknown>;
  /** Short-lived signed URL. Never a public/bucket URL. */
  url: string | null;
  thumbnailUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationAttemptDTO {
  id: string;
  attemptNumber: number;
  provider: string;
  model: string | null;
  status: JobStatus;
  latencyMs: number | null;
  externalRequestId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface GenerationDTO {
  id: string;
  organizationId: string;
  projectId: string;
  sceneId: string | null;
  requestedBy: string;
  kind: GenerationKind;
  capability: AICapability;
  provider: string | null;
  model: string | null;
  status: GenerationStatus;
  progress: number;
  prompt: string | null;
  parameters: Record<string, unknown>;
  /** Structured result payload; shape depends on `kind`. */
  result: Record<string, unknown> | null;
  outputAssetId: string | null;
  outputUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  creditsUsed: number;
  idempotencyKey: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Populated on detail reads only. */
  attempts?: GenerationAttemptDTO[];
}

export interface ExportFileDTO {
  id: string;
  assetId: string;
  kind: 'video' | 'thumbnail' | 'metadata' | 'audio';
  filename: string;
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  url: string | null;
  createdAt: string;
}

export interface ExportDTO {
  id: string;
  organizationId: string;
  projectId: string;
  requestedBy: string;
  status: ExportStatus;
  progress: number;
  preset: string;
  format: string;
  resolution: string;
  includeAudio: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  /** Set only after the backend has verified the rendered file exists. */
  verified: boolean;
  expiresAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  files?: ExportFileDTO[];
}

export interface TemplateDTO {
  id: string;
  organizationId: string | null;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  aspectRatio: string;
  defaultDurationSeconds: number;
  definition: Record<string, unknown>;
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UsageRecordDTO {
  id: string;
  organizationId: string;
  userId: string | null;
  projectId: string | null;
  capability: AICapability;
  provider: string;
  units: number;
  credits: number;
  createdAt: string;
}

export interface UsageSummaryDTO {
  periodStart: string;
  periodEnd: string;
  creditsUsed: number;
  creditsRemaining: number;
  quota: number;
  byCapability: Record<string, { units: number; credits: number; requests: number }>;
  byProvider: Record<string, { units: number; credits: number; requests: number }>;
}

export interface AuditEventDTO {
  id: string;
  organizationId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  category: AuditCategory;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  ipAddress: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationDTO {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string | null;
  resourceType: string | null;
  resourceId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface JobDTO {
  id: string;
  queue: string;
  name: string;
  status: JobStatus;
  attemptsMade: number;
  maxAttempts: number;
  progress: number;
  organizationId: string | null;
  projectId: string | null;
  generationId: string | null;
  exportId: string | null;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/* -------------------------------------------------------------------------- */
/* API envelope                                                                */
/* -------------------------------------------------------------------------- */

export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface ListResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

export interface ItemResponse<T> {
  data: T;
}

export interface DeletedResponse {
  data: { id: string; deleted: true };
}

export interface AuthSessionDTO {
  user: UserDTO;
  organizations: OrganizationDTO[];
  /** CSRF token the client must echo on state-changing requests. */
  csrfToken: string;
  expiresAt: string;
}
