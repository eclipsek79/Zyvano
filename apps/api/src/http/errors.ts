/**
 * HTTP error handling.
 *
 * Converts any thrown value into the canonical machine-readable error envelope.
 * Internal details (stack traces, SQL, provider payloads) are logged but never
 * returned to the client.
 */
import type { NextFunction, Request, Response } from 'express';

import { AppError, ERROR_CODES, errors, isAppError, type SerializedError } from '@zyvano/shared';

import { logger } from '@zyvano/server/observability/logger';
import { getConfig } from '@zyvano/server/config/env';

/** Wraps an async handler so rejected promises reach the error middleware. */
export function asyncHandler<
  T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
>(handler: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };
}

/** Maps driver-level database errors onto stable application errors. */
function normalizeError(error: unknown): AppError {
  if (isAppError(error)) return error;

  const code = (error as { code?: string } | null)?.code;
  if (code === '23505') {
    return errors.conflict('A record with these details already exists.');
  }
  if (code === '23503') {
    return errors.validation('A referenced record does not exist.');
  }
  if (code === '23502') {
    return errors.validation('A required field is missing.');
  }
  if (code === '22P02') {
    return errors.validation('A supplied identifier or value has an invalid format.');
  }
  return errors.internal();
}

/** Terminal 404 for unmatched routes. */
export function notFoundHandler(req: Request, res: Response): void {
  const error = errors.notFound('Endpoint');
  const body = error.toJSON(req.requestId);
  res.status(error.status).json(body);
}

/** Terminal error handler. Must keep the 4-argument signature for Express. */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const appError = normalizeError(error);

  // Anything that is not an AppError is a bug: log it loudly with the stack.
  const logPayload = {
    err: error,
    requestId: req.requestId,
    code: appError.code,
    status: appError.status,
    method: req.method,
    path: req.originalUrl,
    userId: req.auth?.user.id ?? null,
    organizationId: req.auth?.organizationId ?? null,
    internal: appError.internal,
  };

  if (appError.status >= 500) {
    logger.error(logPayload, 'request failed');
  } else {
    logger.warn(logPayload, 'request rejected');
  }

  const body: SerializedError = appError.toJSON(req.requestId);

  // Retry-After is set for throttled responses so well-behaved clients back off.
  if (appError.code === ERROR_CODES.RATE_LIMITED) {
    const retryAfter = (appError.internal?.retryAfterSeconds as number | undefined) ?? undefined;
    if (retryAfter) res.setHeader('retry-after', String(retryAfter));
  }

  // Never leak a stack trace in production responses.
  if (getConfig().isProduction && appError.status >= 500) {
    delete (body.error as { stack?: unknown }).stack;
  }

  res.status(appError.status).json(body);
}
