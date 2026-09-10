/**
 * Cross-application constants that must stay identical on the server and the
 * client (queue names, cookie names, upload allow-lists, credit costs).
 */
import type { AICapability, GenerationKind } from './types';

/**
 * Which AI capability fulfils each generation kind. Kept here (not in a service)
 * so the API, the worker and the client all agree on the mapping.
 */
export const CAPABILITY_FOR_KIND: Record<GenerationKind, AICapability> = {
  script: 'text',
  storyboard: 'text',
  scene: 'text',
  image: 'image',
  video: 'video',
  voice: 'voice',
  audio: 'audio',
};

export const QUEUE_NAMES = {
  /** Default work queue for domain jobs (script, storyboard, scene, media). */
  DEFAULT: 'zyvano-default',
  /** AI provider calls, kept separate so provider outages don't starve domain work. */
  AI: 'zyvano-ai',
  /** CPU-heavy rendering/encoding jobs. */
  RENDER: 'zyvano-render',
  /** Periodic maintenance: cleanup, retention, orphan reaping. */
  MAINTENANCE: 'zyvano-maintenance',
  /** Terminal failures kept for inspection and manual replay. */
  DEAD_LETTER: 'zyvano-dead-letter',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const JOB_NAMES = {
  GENERATE_SCRIPT: 'GenerateScript',
  GENERATE_STORYBOARD: 'GenerateStoryboard',
  GENERATE_SCENE: 'GenerateScene',
  GENERATE_IMAGE: 'GenerateImage',
  GENERATE_VIDEO: 'GenerateVideo',
  GENERATE_VOICE: 'GenerateVoice',
  PROCESS_MEDIA: 'ProcessMedia',
  RENDER_VIDEO: 'RenderVideo',
  GENERATE_THUMBNAIL: 'GenerateThumbnail',
  EXPORT_PROJECT: 'ExportProject',
  CLEANUP_EXPIRED_FILES: 'CleanupExpiredFiles',
  DELETE_USER_DATA: 'DeleteUserData',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/** Which queue each job name is dispatched to. */
export const JOB_QUEUE_MAP: Record<JobName, QueueName> = {
  GenerateScript: QUEUE_NAMES.AI,
  GenerateStoryboard: QUEUE_NAMES.AI,
  GenerateScene: QUEUE_NAMES.AI,
  GenerateImage: QUEUE_NAMES.AI,
  GenerateVideo: QUEUE_NAMES.AI,
  GenerateVoice: QUEUE_NAMES.AI,
  ProcessMedia: QUEUE_NAMES.DEFAULT,
  RenderVideo: QUEUE_NAMES.RENDER,
  GenerateThumbnail: QUEUE_NAMES.DEFAULT,
  ExportProject: QUEUE_NAMES.RENDER,
  CleanupExpiredFiles: QUEUE_NAMES.MAINTENANCE,
  DeleteUserData: QUEUE_NAMES.MAINTENANCE,
};

/** Credit cost per generation kind, used for usage accounting and quotas. */
export const CREDIT_COSTS = {
  script: 5,
  storyboard: 10,
  scene: 2,
  image: 20,
  video: 120,
  voice: 8,
  audio: 8,
} as const;

export const COOKIE_NAMES = {
  SESSION: 'zyvano_session',
  CSRF: 'zyvano_csrf',
} as const;

/** Header the client echoes the CSRF cookie value in. */
export const CSRF_HEADER = 'x-zyvano-csrf';

export const REQUEST_ID_HEADER = 'x-request-id';

/** Allowed upload MIME types -> canonical asset kind + extension allow-list. */
export const UPLOAD_MIME_ALLOWLIST: Record<string, { kind: 'image' | 'video' | 'audio'; extensions: string[] }> = {
  'image/jpeg': { kind: 'image', extensions: ['jpg', 'jpeg'] },
  'image/png': { kind: 'image', extensions: ['png'] },
  'image/webp': { kind: 'image', extensions: ['webp'] },
  'image/gif': { kind: 'image', extensions: ['gif'] },
  'image/avif': { kind: 'image', extensions: ['avif'] },
  'video/mp4': { kind: 'video', extensions: ['mp4'] },
  'video/webm': { kind: 'video', extensions: ['webm'] },
  'video/quicktime': { kind: 'video', extensions: ['mov'] },
  'audio/mpeg': { kind: 'audio', extensions: ['mp3'] },
  'audio/wav': { kind: 'audio', extensions: ['wav'] },
  'audio/x-wav': { kind: 'audio', extensions: ['wav'] },
  'audio/ogg': { kind: 'audio', extensions: ['ogg'] },
  'audio/mp4': { kind: 'audio', extensions: ['m4a'] },
};

/** Extension -> MIME map used when a provider returns a media type we must infer. */
export const EXTENSION_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
};

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const SIGNED_URL_TTL_SECONDS = 900;

/** Export presets -> concrete encoding targets consumed by the renderer. */
export const EXPORT_PRESET_TARGETS: Record<
  string,
  { width: number; height: number; videoBitrate: string; audioBitrate: string; label: string }
> = {
  'web-720p': { width: 1280, height: 720, videoBitrate: '2500k', audioBitrate: '128k', label: 'Web 720p' },
  'web-1080p': { width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k', label: 'Web 1080p' },
  'social-vertical': {
    width: 1080,
    height: 1920,
    videoBitrate: '4500k',
    audioBitrate: '192k',
    label: 'Social vertical 9:16',
  },
  'social-square': {
    width: 1080,
    height: 1080,
    videoBitrate: '4000k',
    audioBitrate: '192k',
    label: 'Social square 1:1',
  },
  'master-4k': { width: 3840, height: 2160, videoBitrate: '20000k', audioBitrate: '320k', label: 'Master 4K' },
};
