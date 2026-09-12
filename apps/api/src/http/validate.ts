/**
 * Request validation.
 *
 * The API re-validates every payload server-side with the same shared schemas
 * the client uses. Client-side validation is a convenience, never a control.
 */
import type { Request } from 'express';
import type { z } from 'zod';

import { errors, type ErrorDetail } from '@zyvano/shared';

/** Converts zod issues into the canonical field-level error details. */
function toDetails(error: z.ZodError): ErrorDetail[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
    reason: issue.code,
  }));
}

/**
 * Parses a request body, throwing a VALIDATION_ERROR carrying every field-level
 * problem rather than failing on the first one.
 */
export function parseBody<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw errors.validation('The request body is invalid.', toDetails(result.error));
  }
  return result.data;
}

/** Parses and coerces query-string values (all query input arrives as strings). */
export function parseQuery<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw errors.validation('The query parameters are invalid.', toDetails(result.error));
  }
  return result.data;
}

/** Parses route parameters. */
export function parseParams<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.params);
  if (!result.success) {
    throw errors.validation('The route parameters are invalid.', toDetails(result.error));
  }
  return result.data;
}
