/**
 * Rate limiting.
 *
 * Three buckets with different budgets: authentication (brute-force defence),
 * generation (expensive provider calls) and a general API ceiling. Keying uses
 * the authenticated user when available so a shared NAT does not lock out a
 * whole office, falling back to the client address.
 */
import type { Request } from 'express';
import rateLimit, { type RateLimitRequestHandler } from 'express-rate-limit';
import type { NextFunction, RequestHandler, Response } from 'express';

import { errors } from '@zyvano/shared';

import { getConfig } from '@zyvano/server/config/env';
import { logger } from '@zyvano/server/observability/logger';

function userOrIp(req: Request): string {
  return req.auth?.user.id ?? req.ip ?? 'unknown';
}

function tooMany(): RequestHandler {
  return (_req: Request, _res: Response, next: NextFunction) => {
    next(errors.rateLimited());
  };
}

/**
 * Builds all three limiters. They are created once at startup so their counters
 * and stores are shared across requests rather than reset per call.
 */
export function createRateLimiters(): {
  api: RateLimitRequestHandler;
  auth: RateLimitRequestHandler;
  generation: RateLimitRequestHandler;
} {
  const limits = getConfig().limits;

  const auth = rateLimit({
    windowMs: limits.rateLimitWindowMs,
    max: limits.rateLimitAuthMax,
    standardHeaders: true,
    legacyHeaders: false,
    // Authentication attempts are keyed by address *and* submitted email so an
    // attacker cannot lock a victim out by hammering their account from afar.
    keyGenerator: (req) => {
      const email = (req.body as { email?: string } | undefined)?.email?.toLowerCase() ?? '';
      return `${req.ip ?? 'unknown'}:${email}`;
    },
    handler: tooMany(),
  });

  const generation = rateLimit({
    windowMs: limits.rateLimitWindowMs,
    max: limits.rateLimitGenerationMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userOrIp,
    handler: tooMany(),
  });

  const api = rateLimit({
    windowMs: limits.rateLimitWindowMs,
    max: limits.rateLimitApiMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: userOrIp,
    handler: tooMany(),
  });

  logger.info(
    {
      windowMs: limits.rateLimitWindowMs,
      authMax: limits.rateLimitAuthMax,
      apiMax: limits.rateLimitApiMax,
      generationMax: limits.rateLimitGenerationMax,
    },
    'rate limiters configured',
  );

  return { api, auth, generation };
}
