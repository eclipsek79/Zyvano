/**
 * Request context middleware.
 *
 * Assigns/propagates a correlation id and opens the async-local context that
 * audit records and logs read from. Refuses client-supplied ids that are not
 * well-formed so an attacker cannot poison log correlation.
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { REQUEST_ID_HEADER } from '@zyvano/shared';

import { runWithRequestContext } from '@zyvano/server/observability/request-context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveRequestId(header: string | undefined): string {
  if (header && UUID_RE.test(header)) return header;
  return randomUUID();
}

function clientIp(req: Request): string | null {
  // `trust proxy` is configured at the app level; req.ip is then the left-most
  // untrusted address, which is what we want for audit and rate limiting.
  return req.ip ?? null;
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req.header(REQUEST_ID_HEADER));
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  runWithRequestContext(
    {
      requestId,
      userId: null,
      organizationId: null,
      ipAddress: clientIp(req),
      userAgent: req.header('user-agent') ?? null,
      startedAt: Date.now(),
    },
    () => {
      next();
    },
  );
}
