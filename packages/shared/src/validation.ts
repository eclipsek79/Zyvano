/**
 * Zyvano request validation contracts (zod).
 *
 * These schemas are shared by the API (authoritative server-side validation) and
 * the web client (early feedback / form state). The server always re-validates:
 * client-side validation is never trusted.
 */
import { z } from 'zod';

import { ASSET_KINDS, ORG_ROLES, PROJECT_STATUSES, type ExportPreset } from './types';

/* ------------------------------- primitives ------------------------------- */

export const uuidSchema = z.string().uuid('Must be a valid UUID.');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Email is required.')
  .max(254, 'Email is too long.')
  .email('Must be a valid email address.');

/**
 * Password policy: 10-128 chars with at least one letter and one digit.
 * Deliberately simple, enforced identically on the client and the server.
 */
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .regex(/[A-Za-z]/, 'Password must contain at least one letter.')
  .regex(/[0-9]/, 'Password must contain at least one number.');

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'Slug is too short.')
  .max(64, 'Slug is too long.')
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug may contain lowercase letters, numbers and hyphens.');

/* --------------------------------- auth ----------------------------------- */

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, 'Name is required.').max(120),
  organizationName: z.string().trim().min(1).max(120).optional(),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required.').max(128),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(20, 'Verification token is invalid.').max(200),
});

export const requestPasswordResetSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20, 'Reset token is invalid.').max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.').max(128),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  avatarUrl: z.string().url().max(2048).nullable().optional(),
});

/**
 * Account deletion request.
 *
 * `confirmation` must echo the account's own email address. Deletion destroys every
 * project, scene, asset and export the account owns, so a bare authenticated request
 * is not sufficient evidence of intent — the same reasoning as the project-delete
 * header that must match the project name exactly.
 */
export const deleteAccountSchema = z.object({
  confirmation: z.string().min(1, 'Confirmation is required.').max(320),
  reason: z.string().trim().max(500).optional(),
});

/* ----------------------------- organizations ------------------------------ */

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120),
  slug: slugSchema.optional(),
});

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
});

export const inviteMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(ORG_ROLES.filter((r) => r !== 'owner') as [string, ...string[]]),
});

export const updateMemberRoleSchema = z.object({
  role: z.enum(ORG_ROLES.filter((r) => r !== 'owner') as [string, ...string[]]),
});

/* --------------------------------- projects ------------------------------- */

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required.').max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  prompt: z.string().trim().max(8000).nullable().optional(),
  aspectRatio: z.enum(ASPECT_RATIOS).default('16:9'),
  targetDurationSeconds: z.number().int().min(1).max(3600).nullable().optional(),
  templateId: uuidSchema.nullable().optional(),
});

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    prompt: z.string().trim().max(8000).nullable().optional(),
    aspectRatio: z.enum(ASPECT_RATIOS).optional(),
    targetDurationSeconds: z.number().int().min(1).max(3600).nullable().optional(),
    status: z.enum(PROJECT_STATUSES.filter((s) => s !== 'deleted') as [string, ...string[]]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided.');

export const duplicateProjectSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  includeAssets: z.boolean().default(false),
});

export const addProjectMemberSchema = z.object({
  email: emailSchema,
  role: z.enum(ORG_ROLES as unknown as [string, ...string[]]),
});

/* ---------------------------------- scripts ------------------------------- */

export const createScriptSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(200),
  content: z.string().trim().min(1, 'Content is required.').max(100_000),
  tone: z.string().trim().max(120).nullable().optional(),
  language: z.string().trim().min(2).max(16).default('en'),
});

export const updateScriptSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().trim().min(1).max(100_000).optional(),
    tone: z.string().trim().max(120).nullable().optional(),
    language: z.string().trim().min(2).max(16).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided.');

export const generateScriptSchema = z.object({
  prompt: z.string().trim().min(10, 'Describe the video you want in at least 10 characters.').max(8000),
  tone: z.string().trim().max(120).optional(),
  language: z.string().trim().min(2).max(16).default('en'),
  targetDurationSeconds: z.number().int().min(5).max(3600).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

/* -------------------------------- storyboard ------------------------------ */

export const storyboardShotSchema = z.object({
  sceneNumber: z.number().int().min(1).max(500),
  description: z.string().trim().min(1).max(4000),
  cameraAngle: z.string().trim().max(120).optional(),
  durationSeconds: z.number().min(0.5).max(600).optional(),
});

export const updateStoryboardSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  shots: z.array(storyboardShotSchema).max(500).optional(),
});

export const generateStoryboardSchema = z.object({
  scriptId: uuidSchema.optional(),
  sceneCount: z.number().int().min(1).max(60).default(6),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

/* ---------------------------------- scenes -------------------------------- */

export const createSceneSchema = z.object({
  title: z.string().trim().min(1, 'Scene title is required.').max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  prompt: z.string().trim().max(8000).nullable().optional(),
  durationSeconds: z.number().min(0.5).max(600).default(5),
  orderIndex: z.number().int().min(0).max(1000).optional(),
});

export const updateSceneSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(4000).nullable().optional(),
    prompt: z.string().trim().max(8000).nullable().optional(),
    durationSeconds: z.number().min(0.5).max(600).optional(),
    orderIndex: z.number().int().min(0).max(1000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided.');

export const reorderScenesSchema = z.object({
  sceneIds: z.array(uuidSchema).min(1).max(1000),
});

/* -------------------------------- generation ------------------------------ */

export const generateSceneSchema = z.object({
  sceneId: uuidSchema,
  kind: z.enum(['image', 'video']).default('video'),
  provider: z.string().trim().min(1).max(64).optional(),
  model: z.string().trim().max(128).optional(),
  prompt: z.string().trim().max(8000).optional(),
  durationSeconds: z.number().int().min(1).max(60).optional(),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

export const generateVoiceSchema = z.object({
  text: z.string().trim().min(1, 'Text is required.').max(5000),
  sceneId: uuidSchema.optional(),
  voiceId: z.string().trim().max(128).optional(),
  language: z.string().trim().min(2).max(16).default('en'),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

/* ---------------------------------- assets -------------------------------- */

export const assetKindSchema = z.enum(ASSET_KINDS);
export const assetSourceSchema = z.enum(['upload', 'generated', 'system']);

export const listAssetsQuerySchema = z.object({
  projectId: uuidSchema.optional(),
  kind: assetKindSchema.optional(),
  source: assetSourceSchema.optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(24),
});

export const createUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(3).max(128),
  sizeBytes: z.number().int().min(1),
  projectId: uuidSchema.nullable().optional(),
});

/* ---------------------------------- exports ------------------------------- */

export const EXPORT_PRESETS: readonly ExportPreset[] = [
  'web-720p',
  'web-1080p',
  'social-vertical',
  'social-square',
  'master-4k',
];

/* --------------------------------- exports --------------------------------- */

export const acceptInvitationSchema = z.object({
  token: z.string().min(20, 'Invitation token is invalid.').max(200),
});

export const createExportSchema = z.object({
  // The preset names are validated against the shared ExportPreset union above;
  // z.enum is fed a literal tuple because zod requires a mutable tuple type.
  preset: z
    .enum(['web-720p', 'web-1080p', 'social-vertical', 'social-square', 'master-4k'])
    .default('web-1080p'),
  format: z.enum(['mp4', 'webm']).default('mp4'),
  includeAudio: z.boolean().default(true),
  idempotencyKey: z.string().trim().min(8).max(128).optional(),
});

/* -------------------------------- templates ------------------------------- */

export const listTemplatesQuerySchema = z.object({
  category: z.string().trim().max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(24),
});

/* ------------------------------ shared queries ---------------------------- */

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.string().trim().max(64).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().max(200).optional(),
});

export const listProjectsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(PROJECT_STATUSES).optional(),
  organizationId: uuidSchema.optional(),
});

export const listGenerationsQuerySchema = paginationQuerySchema.extend({
  projectId: uuidSchema.optional(),
  status: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']).optional(),
  kind: z.enum(['script', 'storyboard', 'scene', 'image', 'video', 'voice', 'audio']).optional(),
});

export const listExportsQuerySchema = paginationQuerySchema.extend({
  projectId: uuidSchema.optional(),
  status: z.enum(['queued', 'processing', 'completed', 'failed', 'cancelled']).optional(),
});

export const listAuditQuerySchema = paginationQuerySchema.extend({
  category: z.string().trim().max(64).optional(),
  action: z.string().trim().max(128).optional(),
  resourceId: uuidSchema.optional(),
});

export const usageSummaryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/* ------------------------------ inferred types ---------------------------- */

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type DuplicateProjectInput = z.infer<typeof duplicateProjectSchema>;
export type AddProjectMemberInput = z.infer<typeof addProjectMemberSchema>;
export type CreateScriptInput = z.infer<typeof createScriptSchema>;
export type UpdateScriptInput = z.infer<typeof updateScriptSchema>;
export type GenerateScriptInput = z.infer<typeof generateScriptSchema>;
export type UpdateStoryboardInput = z.infer<typeof updateStoryboardSchema>;
export type GenerateStoryboardInput = z.infer<typeof generateStoryboardSchema>;
export type CreateSceneInput = z.infer<typeof createSceneSchema>;
export type UpdateSceneInput = z.infer<typeof updateSceneSchema>;
export type GenerateSceneInput = z.infer<typeof generateSceneSchema>;
export type GenerateVoiceInput = z.infer<typeof generateVoiceSchema>;
export type CreateUploadInput = z.infer<typeof createUploadSchema>;
export type CreateExportInput = z.infer<typeof createExportSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
export type ListAssetsQuery = z.infer<typeof listAssetsQuerySchema>;
export type ListGenerationsQuery = z.infer<typeof listGenerationsQuerySchema>;
export type ListExportsQuery = z.infer<typeof listExportsQuerySchema>;
export type ListAuditQuery = z.infer<typeof listAuditQuerySchema>;
export type UsageSummaryQuery = z.infer<typeof usageSummaryQuerySchema>;
