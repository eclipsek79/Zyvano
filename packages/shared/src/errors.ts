/**
 * Zyvano canonical error model.
 *
 * Every failure surfaced by the API is expressed as an `AppError` with a stable
 * machine-readable `code`, an HTTP status and a safe, non-leaking message.
 * Internal details (stack traces, provider responses, SQL) never reach clients.
 */

export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  FORBIDDEN: 'FORBIDDEN',
  INSUFFICIENT_ROLE: 'INSUFFICIENT_ROLE',
  CSRF_INVALID: 'CSRF_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  INFRASTRUCTURE_ERROR: 'INFRASTRUCTURE_ERROR',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  JOB_FAILED: 'JOB_FAILED',
  GONE: 'GONE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorDetail {
  /** Dotted path of the offending field, when the error is field-scoped. */
  field?: string;
  /** Human readable explanation, safe to display. */
  message: string;
  /** Optional machine-readable sub-reason. */
  reason?: string;
}

export interface SerializedError {
  error: {
    code: ErrorCode;
    message: string;
    details?: ErrorDetail[];
    requestId?: string;
    /** True when the client may safely retry the same operation. */
    retryable: boolean;
  };
}

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ERROR_CODES.RATE_LIMITED,
  ERROR_CODES.PROVIDER_ERROR,
  ERROR_CODES.INFRASTRUCTURE_ERROR,
  ERROR_CODES.JOB_FAILED,
  ERROR_CODES.INTERNAL_ERROR,
]);

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[];
  readonly retryable: boolean;
  /** Internal-only context. Logged, never serialized to the client. */
  readonly internal?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    options?: { details?: ErrorDetail[]; internal?: Record<string, unknown>; retryable?: boolean },
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = options?.details ?? [];
    this.internal = options?.internal;
    this.retryable = options?.retryable ?? RETRYABLE.has(code);
    Error.captureStackTrace?.(this, AppError);
  }

  toJSON(requestId?: string): SerializedError {
    const body: SerializedError['error'] = {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.details.length > 0) body.details = this.details;
    if (requestId) body.requestId = requestId;
    return { error: body };
  }
}

export const errors = {
  validation: (message: string, details?: ErrorDetail[]) =>
    new AppError(ERROR_CODES.VALIDATION_ERROR, message, 422, { details }),
  badRequest: (message: string, details?: ErrorDetail[]) =>
    new AppError(ERROR_CODES.VALIDATION_ERROR, message, 400, { details }),
  unauthenticated: (message = 'Authentication is required.') =>
    new AppError(ERROR_CODES.AUTHENTICATION_REQUIRED, message, 401),
  invalidCredentials: () =>
    new AppError(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid email or password.', 401),
  sessionExpired: () => new AppError(ERROR_CODES.SESSION_EXPIRED, 'Your session has expired.', 401),
  emailNotVerified: () =>
    new AppError(ERROR_CODES.EMAIL_NOT_VERIFIED, 'Email address has not been verified.', 403),
  csrf: () => new AppError(ERROR_CODES.CSRF_INVALID, 'Invalid or missing CSRF token.', 403),
  forbidden: (message = 'You do not have permission to perform this action.') =>
    new AppError(ERROR_CODES.FORBIDDEN, message, 403),
  insufficientRole: (required: string) =>
    new AppError(
      ERROR_CODES.INSUFFICIENT_ROLE,
      `This action requires the ${required} role or higher.`,
      403,
      { internal: { required } },
    ),
  notFound: (resource = 'Resource') => new AppError(ERROR_CODES.NOT_FOUND, `${resource} not found.`, 404),
  conflict: (message: string, details?: ErrorDetail[]) =>
    new AppError(ERROR_CODES.CONFLICT, message, 409, { details }),
  rateLimited: (message = 'Too many requests. Please retry shortly.', retryAfterSeconds?: number) =>
    new AppError(ERROR_CODES.RATE_LIMITED, message, 429, {
      internal: retryAfterSeconds ? { retryAfterSeconds } : undefined,
    }),
  quotaExceeded: (message = 'Usage quota exceeded for this period.') =>
    new AppError(ERROR_CODES.QUOTA_EXCEEDED, message, 402),
  providerNotConfigured: (provider: string, capability: string) =>
    new AppError(
      ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      `The ${capability} provider "${provider}" is not configured on this deployment. ` +
        'An administrator must supply the provider credentials before this operation can run.',
      503,
      { internal: { provider, capability } },
    ),
  providerError: (provider: string, message: string, internal?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.PROVIDER_ERROR, message, 502, {
      internal: { provider, ...internal },
    }),
  infrastructure: (message = 'A required infrastructure service is unavailable.', internal?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.INFRASTRUCTURE_ERROR, message, 503, { internal }),
  unsupportedMediaType: (message: string, details?: ErrorDetail[]) =>
    new AppError(ERROR_CODES.UNSUPPORTED_MEDIA_TYPE, message, 415, { details }),
  payloadTooLarge: (message: string) =>
    new AppError(ERROR_CODES.PAYLOAD_TOO_LARGE, message, 413),
  /** The resource existed but is intentionally no longer available (expired export). */
  gone: (message = 'This resource is no longer available.') =>
    new AppError(ERROR_CODES.GONE, message, 410),
  jobFailed: (jobName: string, internal?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.JOB_FAILED, `Job "${jobName}" failed.`, 500, { internal }),
  internal: (message = 'An unexpected error occurred.', internal?: Record<string, unknown>) =>
    new AppError(ERROR_CODES.INTERNAL_ERROR, message, 500, { internal }),
};

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Status code used when an unknown (non-AppError) failure reaches the HTTP layer. */
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
} as const;
