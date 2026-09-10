/**
 * Zyvano API surface.
 *
 * Every function here maps to one real endpoint in `apps/api`. Nothing in this
 * module invents data: a failure propagates as an `ApiError` so the UI can show
 * the actual server reason instead of an optimistic guess.
 */
import type {
  AssetDTO,
  AssetKind,
  AssetSource,
  AuditEventDTO,
  AuthSessionDTO,
  CreateProjectInput,
  CreateSceneInput,
  CreateScriptInput,
  ExportDTO,
  ExportFileDTO,
  ExportPreset,
  GenerationDTO,
  GenerationKind,
  GenerationStatus,
  JobDTO,
  NotificationDTO,
  OrganizationDTO,
  OrgRole,
  ProjectDTO,
  ProjectMemberDTO,
  SceneDTO,
  ScriptDTO,
  StoryboardDTO,
  TemplateDTO,
  UpdateProjectInput,
  UserDTO,
  UsageRecordDTO,
  UsageSummaryDTO,
} from '@zyvano/shared';

import { apiRequest, requestItem, requestList } from './api-client';

/** Query parameters accepted by list endpoints. */
type Query = Record<string, string | number | boolean | undefined | null>;

/* ----------------------------------- auth --------------------------------- */

export interface RegisterPayload {
  email: string;
  password: string;
  displayName: string;
  organizationName?: string;
}

export const authApi = {
  register: (body: RegisterPayload) =>
    requestItem<AuthSessionDTO>('/auth/register', { method: 'POST', body }),

  login: (body: { email: string; password: string }) =>
    requestItem<AuthSessionDTO>('/auth/login', { method: 'POST', body }),

  /** Returns the live session for the current cookies, or throws 401. */
  me: () => requestItem<AuthSessionDTO>('/auth/me'),

  logout: () => apiRequest<void>('/auth/logout', { method: 'POST', body: {} }),

  verifyEmail: (token: string) =>
    apiRequest<void>('/auth/email/verify', { method: 'POST', body: { token } }),

  resendVerification: () => apiRequest<void>('/auth/email/resend', { method: 'POST', body: {} }),

  forgotPassword: (email: string) =>
    apiRequest<void>('/auth/password/forgot', { method: 'POST', body: { email } }),

  resetPassword: (body: { token: string; password: string }) =>
    apiRequest<void>('/auth/password/reset', { method: 'POST', body }),

  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    apiRequest<void>('/auth/password/change', { method: 'POST', body }),

  revokeAllSessions: () =>
    apiRequest<void>('/auth/sessions/revoke-all', { method: 'POST', body: {} }),
};

/* ----------------------------------- users -------------------------------- */

export const usersApi = {
  me: () => requestItem<UserDTO>('/users/me'),
  updateProfile: (body: { displayName?: string }) =>
    requestItem<UserDTO>('/users/me', { method: 'PATCH', body }),
};

/* ------------------------------- organizations ---------------------------- */

export interface OrganizationInvitation {
  id: string;
  email: string;
  role: OrgRole;
  expiresAt: string;
  createdAt: string;
}

export const organizationsApi = {
  list: () => requestItem<OrganizationDTO[]>('/organizations'),

  get: (organizationId: string) =>
    requestItem<OrganizationDTO>(`/organizations/${organizationId}`, { organizationId }),

  create: (body: { name: string; slug?: string }) =>
    requestItem<OrganizationDTO>('/organizations', { method: 'POST', body }),

  update: (organizationId: string, body: { name?: string }) =>
    requestItem<OrganizationDTO>(`/organizations/${organizationId}`, {
      method: 'PATCH',
      body,
      organizationId,
    }),

  members: (organizationId: string) =>
    requestItem<ProjectMemberDTO[]>(`/organizations/${organizationId}/members`, { organizationId }),

  invite: (organizationId: string, body: { email: string; role: Exclude<OrgRole, 'owner'> }) =>
    requestItem<OrganizationInvitation>(`/organizations/${organizationId}/invitations`, {
      method: 'POST',
      body,
      organizationId,
    }),

  invitations: (organizationId: string) =>
    requestItem<OrganizationInvitation[]>(`/organizations/${organizationId}/invitations`, {
      organizationId,
    }),

  revokeInvitation: (organizationId: string, invitationId: string) =>
    apiRequest<void>(`/organizations/${organizationId}/invitations/${invitationId}`, {
      method: 'DELETE',
      organizationId,
    }),

  changeMemberRole: (organizationId: string, userId: string, role: Exclude<OrgRole, 'owner'>) =>
    apiRequest<void>(`/organizations/${organizationId}/members/${userId}`, {
      method: 'PATCH',
      body: { role },
      organizationId,
    }),

  removeMember: (organizationId: string, userId: string) =>
    apiRequest<void>(`/organizations/${organizationId}/members/${userId}`, {
      method: 'DELETE',
      organizationId,
    }),

  acceptInvitation: (token: string) =>
    requestItem<OrganizationDTO>('/organizations/invitations/accept', {
      method: 'POST',
      body: { token },
    }),
};

/* --------------------------------- projects ------------------------------- */

export const projectsApi = {
  list: (query: Query = {}) => requestList<ProjectDTO>('/projects', { query }),
  get: (projectId: string) => requestItem<ProjectDTO>(`/projects/${projectId}`),

  create: (body: CreateProjectInput) =>
    requestItem<ProjectDTO>('/projects', { method: 'POST', body }),

  update: (projectId: string, body: UpdateProjectInput) =>
    requestItem<ProjectDTO>(`/projects/${projectId}`, { method: 'PATCH', body }),

  /**
   * Permanently deletes the project.
   *
   * The API requires the exact project name in `x-zyvano-confirm` so a stray or
   * replayed request cannot destroy a project. Callers must pass the name they
   * showed the user in the confirmation dialog.
   */
  remove: (projectId: string, confirmationName: string) =>
    apiRequest<void>(`/projects/${projectId}`, {
      method: 'DELETE',
      extraHeaders: { 'x-zyvano-confirm': confirmationName },
    }),

  archive: (projectId: string) =>
    requestItem<ProjectDTO>(`/projects/${projectId}/archive`, { method: 'POST', body: {} }),

  duplicate: (projectId: string, body: { name?: string; includeAssets?: boolean } = {}) =>
    requestItem<ProjectDTO>(`/projects/${projectId}/duplicate`, { method: 'POST', body }),

  members: (projectId: string) =>
    requestItem<ProjectMemberDTO[]>(`/projects/${projectId}/members`),

  addMember: (projectId: string, body: { email: string; role: OrgRole }) =>
    requestItem<ProjectMemberDTO>(`/projects/${projectId}/members`, { method: 'POST', body }),

  removeMember: (projectId: string, userId: string) =>
    apiRequest<void>(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),

  /** Resolves which organization owns a project, for direct-link entry. */
  access: (projectId: string) =>
    requestItem<{ projectId: string; organizationId: string; role: OrgRole }>(
      `/projects/${projectId}/access`,
    ),
};

/* ---------------------------------- scenes -------------------------------- */

export const scenesApi = {
  list: (projectId: string) => requestItem<SceneDTO[]>(`/projects/${projectId}/scenes`),

  create: (projectId: string, body: CreateSceneInput) =>
    requestItem<SceneDTO>(`/projects/${projectId}/scenes`, { method: 'POST', body }),

  update: (projectId: string, sceneId: string, body: Partial<CreateSceneInput>) =>
    requestItem<SceneDTO>(`/projects/${projectId}/scenes/${sceneId}`, { method: 'PATCH', body }),

  remove: (projectId: string, sceneId: string) =>
    apiRequest<void>(`/projects/${projectId}/scenes/${sceneId}`, { method: 'DELETE' }),

  /** Persists a new scene order. The server returns the re-sequenced list. */
  reorder: (projectId: string, sceneIds: string[]) =>
    requestItem<SceneDTO[]>(`/projects/${projectId}/scenes/reorder`, {
      method: 'POST',
      body: { sceneIds },
    }),
};

/* --------------------------- scripts & storyboards ------------------------ */

export const scriptsApi = {
  list: (projectId: string) => requestItem<ScriptDTO[]>(`/projects/${projectId}/scripts`),

  create: (projectId: string, body: CreateScriptInput) =>
    requestItem<ScriptDTO>(`/projects/${projectId}/scripts`, { method: 'POST', body }),

  /**
   * Queues script generation. Returns a generation row with status `queued`; the
   * caller polls that row rather than assuming any outcome.
   */
  generate: (
    projectId: string,
    body: {
      prompt: string;
      tone?: string;
      language?: string;
      targetDurationSeconds?: number;
      idempotencyKey?: string;
    },
  ) =>
    requestItem<{ generation: GenerationDTO; deduplicated: boolean }>(
      `/projects/${projectId}/scripts/generate`,
      { method: 'POST', body },
    ),

  update: (scriptId: string, body: { title?: string; content?: string; tone?: string | null }) =>
    requestItem<ScriptDTO>(`/scripts/${scriptId}`, { method: 'PATCH', body }),

  remove: (scriptId: string) => apiRequest<void>(`/scripts/${scriptId}`, { method: 'DELETE' }),

  storyboards: (projectId: string) =>
    requestItem<StoryboardDTO[]>(`/projects/${projectId}/storyboards`),

  generateStoryboard: (
    projectId: string,
    body: { scriptId?: string; sceneCount?: number; idempotencyKey?: string },
  ) =>
    requestItem<{ generation: GenerationDTO; deduplicated: boolean }>(
      `/projects/${projectId}/storyboards/generate`,
      { method: 'POST', body },
    ),

  updateStoryboard: (storyboardId: string, body: { title?: string; shots?: unknown[] }) =>
    requestItem<StoryboardDTO>(`/storyboards/${storyboardId}`, { method: 'PATCH', body }),
};

/* --------------------------------- assets --------------------------------- */

export const assetsApi = {
  list: (query: Query = {}) => requestList<AssetDTO>('/assets', { query }),
  get: (assetId: string) => requestItem<AssetDTO>(`/assets/${assetId}`),
  remove: (assetId: string) => apiRequest<void>(`/assets/${assetId}`, { method: 'DELETE' }),

  /**
   * Uploads a file as multipart form data.
   *
   * Uses `XMLHttpRequest` rather than `fetch` because upload progress is a real
   * requirement for large media and the Fetch API still cannot report request
   * progress. The CSRF header and session cookie are applied exactly as in the
   * JSON client; a rejected upload surfaces the server's own error code.
   */
  upload: (input: {
    file: File;
    projectId?: string | null;
    organizationId?: string | null;
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  }): Promise<AssetDTO> => {
    return new Promise<AssetDTO>((resolve, reject) => {
      const csrfMatch = document.cookie.match(/(?:^|; )zyvano_csrf=([^;]*)/);
      const csrf = csrfMatch?.[1] ? decodeURIComponent(csrfMatch[1]) : null;
      const orgId = input.organizationId ?? null;

      const query = input.projectId ? `?projectId=${encodeURIComponent(input.projectId)}` : '';
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/v1/assets${query}`);
      xhr.withCredentials = true;
      xhr.responseType = 'text';
      xhr.setRequestHeader('accept', 'application/json');
      if (csrf) xhr.setRequestHeader('x-zyvano-csrf', csrf);
      if (orgId) xhr.setRequestHeader('x-zyvano-organization', orgId);

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && input.onProgress) {
          input.onProgress(Math.round((event.loaded / event.total) * 100));
        }
      };

      xhr.onload = () => {
        const payload = safeParse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve((payload as { data: AssetDTO }).data);
          return;
        }
        const envelope = (payload as { error?: { code?: string; message?: string } } | null)?.error;
        reject(
          Object.assign(new Error(envelope?.message ?? 'Upload failed.'), {
            name: 'ApiError',
            code: envelope?.code ?? 'INTERNAL_ERROR',
            status: xhr.status,
          }),
        );
      };

      xhr.onerror = () => reject(new Error('The upload could not reach the server.'));
      xhr.onabort = () => reject(new DOMException('Upload aborted', 'AbortError'));

      if (input.signal) {
        input.signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }

      const form = new FormData();
      form.append('file', input.file, input.file.name);
      xhr.send(form);
    });
  },

  /**
   * Same-origin URL that streams the asset bytes.
   *
   * Authorization is re-checked on every request, so this is safe to use directly
   * in `img`/`video` sources — no long-lived bucket URL is ever handed to the
   * browser.
   */
  contentUrl: (assetId: string, organizationId?: string | null) =>
    organizationId
      ? `/api/v1/assets/${assetId}/content?organizationId=${encodeURIComponent(organizationId)}`
      : `/api/v1/assets/${assetId}/content`,
};

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ------------------------------ generations ------------------------------- */

export const generationsApi = {
  list: (query: Query = {}) => requestList<GenerationDTO>('/generations', { query }),

  get: (generationId: string, includeAttempts = false) =>
    requestItem<GenerationDTO>(
      `/generations/${generationId}${includeAttempts ? '?includeAttempts=true' : ''}`,
    ),

  /** Queues an image or video render for one scene. */
  generateScene: (body: {
    sceneId: string;
    kind?: 'image' | 'video';
    prompt?: string;
    durationSeconds?: number;
    provider?: string;
    model?: string;
    idempotencyKey?: string;
  }) =>
    requestItem<{ generation: GenerationDTO; deduplicated: boolean }>('/generations/scenes', {
      method: 'POST',
      body,
    }),

  generateVoice: (body: {
    text: string;
    sceneId?: string;
    projectId?: string;
    voiceId?: string;
    language?: string;
    idempotencyKey?: string;
  }) =>
    requestItem<{ generation: GenerationDTO; deduplicated: boolean }>('/generations/voice', {
      method: 'POST',
      body,
    }),

  cancel: (generationId: string) =>
    requestItem<GenerationDTO>(`/generations/${generationId}/cancel`, { method: 'POST', body: {} }),

  /** Re-queues a failed generation, preserving its original parameters. */
  retry: (generationId: string) =>
    requestItem<{ generation: GenerationDTO; deduplicated: boolean }>(
      `/generations/${generationId}/retry`,
      { method: 'POST', body: {} },
    ),
};

/* --------------------------------- exports -------------------------------- */

export interface ExportDownloadLink {
  url: string;
  filename: string;
  expiresAt: string;
}

export const exportsApi = {
  list: (query: Query = {}) => requestList<ExportDTO>('/exports', { query }),
  get: (exportId: string) => requestItem<ExportDTO>(`/exports/${exportId}`),

  /** Queues a project render. The project id travels in the body. */
  create: (
    projectId: string,
    body: {
      preset?: ExportPreset;
      format?: 'mp4' | 'webm';
      includeAudio?: boolean;
      idempotencyKey?: string;
    },
  ) =>
    requestItem<{ export: ExportDTO; deduplicated: boolean }>('/exports', {
      method: 'POST',
      body: { projectId, ...body },
    }),

  /**
   * Mints a short-lived download URL.
   *
   * The API verifies the rendered file actually exists before returning a link,
   * so a successful response is the only proof an export is downloadable.
   */
  download: (exportId: string) =>
    requestItem<ExportDownloadLink>(`/exports/${exportId}/download`),

  cancel: (exportId: string) =>
    requestItem<ExportDTO>(`/exports/${exportId}/cancel`, { method: 'POST', body: {} }),

  retry: (exportId: string) =>
    requestItem<ExportDTO>(`/exports/${exportId}/retry`, { method: 'POST', body: {} }),
};

/* -------------------------- templates, usage, audit ----------------------- */

export const templatesApi = {
  list: (query: Query = {}) => requestList<TemplateDTO>('/templates', { query }),
  get: (templateId: string) => requestItem<TemplateDTO>(`/templates/${templateId}`),
};

export const usageApi = {
  summary: (days = 30) => requestItem<UsageSummaryDTO>('/usage', { query: { days } }),
  records: () => requestItem<UsageRecordDTO[]>('/usage/records'),
};

export const auditApi = {
  list: (query: Query = {}) => requestList<AuditEventDTO>('/audit', { query }),
};

export const notificationsApi = {
  list: () => requestItem<NotificationDTO[]>('/notifications'),
  unreadCount: () => requestItem<{ count: number }>('/notifications/unread-count'),
  markRead: (notificationId: string) =>
    apiRequest<void>(`/notifications/${notificationId}/read`, { method: 'POST', body: {} }),
  markAllRead: () => apiRequest<void>('/notifications/read-all', { method: 'POST', body: {} }),
};

export const jobsApi = {
  /** Fetches the worker job behind an asynchronous operation, including its error. */
  get: (jobId: string) => requestItem<JobDTO>(`/jobs/${jobId}`),
};

export type {
  AssetDTO,
  AssetKind,
  AssetSource,
  ExportDTO,
  ExportFileDTO,
  ExportPreset,
  GenerationDTO,
  GenerationKind,
  GenerationStatus,
  JobDTO,
  ProjectDTO,
  SceneDTO,
  ScriptDTO,
  StoryboardDTO,
};
