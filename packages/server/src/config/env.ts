/**
 * Centralized, validated configuration.
 *
 * Rules enforced here:
 *  - Every variable is parsed and validated once, at process start.
 *  - Production fails fast when a mandatory variable is missing or unsafe.
 *  - No credential is ever hard-coded; defaults exist only for local development
 *    and are explicitly rejected in production.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

/* ------------------------------ env file load ----------------------------- */

const repoRoot = path.resolve(__dirname, '../../../..');
for (const candidate of [path.join(repoRoot, '.env'), path.join(process.cwd(), '.env')]) {
  if (existsSync(candidate)) {
    dotenv.config({ path: candidate });
    break;
  }
}

const bool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(defaultValue)
    .transform((value) => {
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const int = (defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APPLICATION_URL: z.string().url().default('http://localhost:3000'),
  API_PORT: int(4000, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required.'),
  DATABASE_POOL_MAX: int(10, 1, 200),

  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),

  AUTH_SECRET: z.string().default(''),
  SESSION_TTL_HOURS: int(720, 1, 8760),
  SESSION_ROTATE_MINUTES: int(60, 5, 1440),
  COOKIE_SECURE: bool(false),
  COOKIE_DOMAIN: z.string().default(''),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('storage'),
  STORAGE_ENDPOINT: z.string().default(''),
  STORAGE_REGION: z.string().default('us-east-1'),
  STORAGE_BUCKET: z.string().default('zyvano-media'),
  STORAGE_ACCESS_KEY: z.string().default(''),
  STORAGE_SECRET_KEY: z.string().default(''),
  STORAGE_FORCE_PATH_STYLE: bool(true),

  MEDIA_FFMPEG_PATH: z.string().default('ffmpeg'),
  MEDIA_FFPROBE_PATH: z.string().default('ffprobe'),
  /**
   * Thread budget per encode.
   *
   * The encoder otherwise sizes its thread pool to every core on the host and uses
   * every frame in flight, so a single render can saturate the machine and starve the
   * worker process that supervises it. Pinning the budget keeps concurrent renders
   * predictable and, importantly, keeps the supervising process responsive enough to
   * report a real failure instead of being killed alongside the encoder.
   */
  MEDIA_FFMPEG_THREADS: int(2, 1, 64),
  /**
   * Encoder preset used for exports.
   *
   * Slower presets trade memory and time for a marginal size gain; during a render the
   * additional resident frames are what exceed a container's memory limit. `veryfast`
   * keeps peak memory bounded, which matters more than a few percent of file size.
   */
  MEDIA_FFMPEG_PRESET: z
    .enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'])
    .default('superfast'),
  /** Encoder buffer size, which caps how much output the muxer holds in memory. */
  MEDIA_ENCODER_BUFSIZE: z.string().default('8M'),
  /** Maximum number of packets the muxer may queue before dropping. */
  MEDIA_MUXING_QUEUE_SIZE: int(512, 16, 4096),
  /**
   * Whether the deployment can actually encode video. When false, render jobs
   * fail fast with a clear configuration error instead of spawning a process that
   * is not installed. The probe job also reports this so an operator can see the
   * capability is missing rather than discovering it at export time.
   */
  MEDIA_PROCESSING_ENABLED: bool(true),

  EMAIL_DRIVER: z.enum(['smtp', 'console', 'none']).default('console'),
  EMAIL_FROM: z.string().default('Zyvano <no-reply@zyvano.local>'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: int(587, 1, 65535),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_SECURE: bool(false),

  AI_DEFAULT_TEXT_PROVIDER: z.string().default('openai'),
  AI_DEFAULT_IMAGE_PROVIDER: z.string().default('openai'),
  AI_DEFAULT_VIDEO_PROVIDER: z.string().default('replicate'),
  AI_DEFAULT_AUDIO_PROVIDER: z.string().default('elevenlabs'),
  AI_DEFAULT_VOICE_PROVIDER: z.string().default('elevenlabs'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_TEXT_MODEL: z.string().default('gpt-4o-mini'),
  REPLICATE_API_TOKEN: z.string().default(''),
  REPLICATE_BASE_URL: z.string().default('https://api.replicate.com/v1'),
  ELEVENLABS_API_KEY: z.string().default(''),
  ELEVENLABS_BASE_URL: z.string().default('https://api.elevenlabs.io/v1'),
  AI_REQUEST_TIMEOUT_MS: int(120_000, 1_000, 600_000),

  WORKER_CONCURRENCY: int(4, 1, 64),
  WORKER_QUEUE_PREFIX: z.string().default('zyvano'),
  JOB_MAX_ATTEMPTS: int(5, 1, 20),
  JOB_BACKOFF_MS: int(2_000, 100, 120_000),

  RATE_LIMIT_WINDOW_MS: int(60_000, 1_000, 3_600_000),
  RATE_LIMIT_AUTH_MAX: int(10, 1, 10_000),
  RATE_LIMIT_API_MAX: int(300, 1, 100_000),
  RATE_LIMIT_GENERATION_MAX: int(30, 1, 10_000),
  MAX_UPLOAD_BYTES: int(524_288_000, 1024, 5_368_709_120),
  FREE_TIER_CREDITS: int(1_000, 0),

  EXPORT_RETENTION_DAYS: int(30, 1, 3650),
  UPLOAD_RETENTION_DAYS: int(365, 1, 3650),
});

export type RawEnv = z.infer<typeof envSchema>;

/* --------------------------- production hardening -------------------------- */

function assertProductionSafety(env: RawEnv): string[] {
  const problems: string[] = [];

  if (env.NODE_ENV !== 'production') return problems;

  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 64) {
    problems.push('AUTH_SECRET must be at least 64 characters in production.');
  }
  if (env.AUTH_SECRET.startsWith('change-me')) {
    problems.push('AUTH_SECRET is still set to the example placeholder value.');
  }
  if (!env.COOKIE_SECURE) {
    problems.push('COOKIE_SECURE must be true in production (session cookies require TLS).');
  }
  if (!env.APPLICATION_URL.startsWith('https://')) {
    problems.push('APPLICATION_URL must use https:// in production.');
  }
  if (env.STORAGE_DRIVER === 's3') {
    if (!env.STORAGE_BUCKET) problems.push('STORAGE_BUCKET is required when STORAGE_DRIVER=s3.');
    if (!env.STORAGE_ACCESS_KEY || !env.STORAGE_SECRET_KEY) {
      problems.push('STORAGE_ACCESS_KEY and STORAGE_SECRET_KEY are required when STORAGE_DRIVER=s3.');
    }
  }
  if (env.EMAIL_DRIVER === 'console') {
    problems.push('EMAIL_DRIVER must not be "console" in production.');
  }
  if (env.EMAIL_DRIVER === 'smtp' && !env.SMTP_HOST) {
    problems.push('SMTP_HOST is required when EMAIL_DRIVER=smtp.');
  }
  return problems;
}

function buildConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  const env = parsed.data;
  const problems = assertProductionSafety(env);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to start in production with unsafe configuration:\n${problems
        .map((p) => `  - ${p}`)
        .join('\n')}`,
    );
  }

  // Development convenience: derive a deterministic local secret so the app can
  // boot without a .env file. This branch is unreachable in production because
  // AUTH_SECRET is validated above.
  const authSecret =
    env.AUTH_SECRET && env.AUTH_SECRET.length >= 32
      ? env.AUTH_SECRET
      : 'zyvano-development-only-secret-not-for-production-use';

  return {
    nodeEnv: env.NODE_ENV,
    isProduction: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    applicationUrl: env.APPLICATION_URL,
    apiPort: env.API_PORT,
    logLevel: env.LOG_LEVEL,

    databaseUrl: env.DATABASE_URL,
    databasePoolMax: env.DATABASE_POOL_MAX,

    redisUrl: env.REDIS_URL,

    authSecret,
    sessionTtlHours: env.SESSION_TTL_HOURS,
    sessionRotateMinutes: env.SESSION_ROTATE_MINUTES,
    cookieSecure: env.COOKIE_SECURE,
    cookieDomain: env.COOKIE_DOMAIN || undefined,

    storage: {
      driver: env.STORAGE_DRIVER,
      localRoot: path.isAbsolute(env.STORAGE_LOCAL_ROOT)
        ? env.STORAGE_LOCAL_ROOT
        : path.join(repoRoot, env.STORAGE_LOCAL_ROOT),
      endpoint: env.STORAGE_ENDPOINT || undefined,
      region: env.STORAGE_REGION,
      bucket: env.STORAGE_BUCKET,
      accessKey: env.STORAGE_ACCESS_KEY || undefined,
      secretKey: env.STORAGE_SECRET_KEY || undefined,
      forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
    },

    media: {
      enabled: env.MEDIA_PROCESSING_ENABLED,
      ffmpegPath: env.MEDIA_FFMPEG_PATH,
      ffprobePath: env.MEDIA_FFPROBE_PATH,
      threads: env.MEDIA_FFMPEG_THREADS,
      preset: env.MEDIA_FFMPEG_PRESET,
      encoderBufferSize: env.MEDIA_ENCODER_BUFSIZE,
      muxingQueueSize: env.MEDIA_MUXING_QUEUE_SIZE,
    },

    email: {
      driver: env.EMAIL_DRIVER,
      from: env.EMAIL_FROM,
      smtpHost: env.SMTP_HOST || undefined,
      smtpPort: env.SMTP_PORT,
      smtpUser: env.SMTP_USER || undefined,
      smtpPassword: env.SMTP_PASSWORD || undefined,
      smtpSecure: env.SMTP_SECURE,
    },

    ai: {
      defaults: {
        text: env.AI_DEFAULT_TEXT_PROVIDER,
        image: env.AI_DEFAULT_IMAGE_PROVIDER,
        video: env.AI_DEFAULT_VIDEO_PROVIDER,
        audio: env.AI_DEFAULT_AUDIO_PROVIDER,
        voice: env.AI_DEFAULT_VOICE_PROVIDER,
      },
      requestTimeoutMs: env.AI_REQUEST_TIMEOUT_MS,
      openai: {
        apiKey: env.OPENAI_API_KEY || undefined,
        baseUrl: env.OPENAI_BASE_URL,
        textModel: env.OPENAI_TEXT_MODEL,
      },
      replicate: {
        apiToken: env.REPLICATE_API_TOKEN || undefined,
        baseUrl: env.REPLICATE_BASE_URL,
      },
      elevenlabs: {
        apiKey: env.ELEVENLABS_API_KEY || undefined,
        baseUrl: env.ELEVENLABS_BASE_URL,
      },
    },

    worker: {
      concurrency: env.WORKER_CONCURRENCY,
      queuePrefix: env.WORKER_QUEUE_PREFIX,
      maxAttempts: env.JOB_MAX_ATTEMPTS,
      backoffMs: env.JOB_BACKOFF_MS,
    },

    limits: {
      rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
      rateLimitAuthMax: env.RATE_LIMIT_AUTH_MAX,
      rateLimitApiMax: env.RATE_LIMIT_API_MAX,
      rateLimitGenerationMax: env.RATE_LIMIT_GENERATION_MAX,
      maxUploadBytes: env.MAX_UPLOAD_BYTES,
      freeTierCredits: env.FREE_TIER_CREDITS,
    },

    retention: {
      exportDays: env.EXPORT_RETENTION_DAYS,
      uploadDays: env.UPLOAD_RETENTION_DAYS,
      exportRetentionDays: env.EXPORT_RETENTION_DAYS,
      uploadRetentionDays: env.UPLOAD_RETENTION_DAYS,
    },

    repoRoot,
  } as const;
}

export type AppConfig = ReturnType<typeof buildConfig>;

let cached: AppConfig | null = null;

/**
 * Returns the validated configuration, loading and validating it on first use.
 * Throws (fail fast) when the environment is invalid or unsafe for production.
 */
export function getConfig(): AppConfig {
  if (!cached) cached = buildConfig();
  return cached;
}

/** Test helper: drop the memoized configuration so a new env can be loaded. */
export function resetConfigCache(): void {
  cached = null;
}

export const config: AppConfig = getConfig();
