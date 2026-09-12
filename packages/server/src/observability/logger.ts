/**
 * Structured logging.
 *
 * Every log line is a JSON object carrying the correlation identifiers the
 * engineering brief requires: requestId, userId, organizationId, projectId,
 * generationId, jobId, provider, latencyMs, errorCode.
 *
 * Secret redaction is applied to *every* logged object, including nested
 * structures and error metadata, so credentials cannot leak through logs even
 * if a caller logs a whole config or provider payload by accident.
 */
import pino from 'pino';

import { getConfig } from '../config/env';

const REDACTED = '[REDACTED]';

/**
 * Substrings that mark a key as sensitive. Matched case-insensitively against
 * the key name so `openaiApiKey`, `authorization`, `set-cookie`, `password`
 * and friends are all covered.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /apikey/i,
  /authorization/i,
  /cookie/i,
  /credential/i,
  /private[_-]?key/i,
  /signature/i,
  /session[_-]?id/i,
  /access[_-]?key/i,
  /service[_-]?role/i,
];

/** Substrings matched against serialized error text to scrub leaked secrets. */
const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
  /(bearer\s+)[A-Za-z0-9._\-+/=]{12,}/gi,
  /(sk-[A-Za-z0-9]{10,})/g,
  /(r8_[A-Za-z0-9]{10,})/g,
  /(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+(@)/gi,
  /(redis:\/\/[^:\s]*:)[^@\s]+(@)/gi,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function scrubString(value: string): string {
  let out = value;
  for (const pattern of SECRET_TEXT_PATTERNS) {
    out = out.replace(pattern, (_match, prefix: string, suffix?: string) =>
      suffix !== undefined ? `${prefix}${REDACTED}${suffix}` : `${prefix}${REDACTED}`,
    );
  }
  return out;
}

/** Recursively redacts sensitive keys and scrubs secret-looking strings. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[Truncated]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      stack: value.stack ? scrubString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(nested, depth + 1);
    }
    return out;
  }
  return String(value);
}

const redactHook = (value: unknown) => redact(value);

export const logger = pino({
  level: getConfig().logLevel,
  base: { service: 'zyvano', env: getConfig().nodeEnv },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    log(object) {
      return redact(object) as Record<string, unknown>;
    },
  },
  hooks: {
    logMethod(args, method) {
      // Redact any Error objects passed positionally so stack traces are safe.
      const safeArgs = args.map((arg) => (arg instanceof Error ? redact(arg) : arg)) as typeof args;
      return method.apply(this, safeArgs);
    },
  },
});

export type Logger = typeof logger;

export interface LogContext {
  requestId?: string;
  userId?: string | null;
  organizationId?: string | null;
  projectId?: string | null;
  generationId?: string | null;
  exportId?: string | null;
  jobId?: string | null;
  provider?: string | null;
  [key: string]: unknown;
}

/**
 * Creates a child logger bound to a correlation context. Extra keys are accepted
 * so handlers can attach resource identifiers without narrowing the type.
 */
export function withContext(context: LogContext): Logger {
  return logger.child(redact(context) as Record<string, unknown>);
}

export { redactHook };
