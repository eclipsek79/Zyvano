/**
 * Authentication middleware.
 *
 * Resolves the session cookie to a live session, rejects expired or revoked
 * sessions, loads the user, rotates the opaque token when it is old, and opens
 * the request context for downstream audit logging.
 *
 * A session that exists but whose user is no longer active is rejected here, so
 * a suspended account cannot keep using a cookie it already holds.
 */
import type { NextFunction, Request, Response } from 'express';

import { COOKIE_NAMES, errors } from '@zyvano/shared';

import type { Container } from '@zyvano/server/container';
import { getConfig } from '@zyvano/server/config/env';
import { logger } from '@zyvano/server/observability/logger';
import { patchRequestContext } from '@zyvano/server/observability/request-context';
import {
  hashSessionToken,
  setSessionCookies,
  shouldRotateSession,
} from '@zyvano/server/security/session';
import { toUserDTO } from '@zyvano/server/db/mappers';

/**
 * Populates `req.auth` when a valid session cookie is present. Never rejects:
 * routes decide whether authentication is required. This lets public endpoints
 * still benefit from an identified caller (for example, rate-limit keying).
 */
export function attachSession(container: Container) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = (req.cookies as Record<string, string | undefined> | undefined)?.[
        COOKIE_NAMES.SESSION
      ];
      if (!raw) return next();

      // The cookie is resolved through the keyed digest, so a cookie issued under a
      // previous AUTH_SECRET no longer matches any stored hash and is treated as an
      // unknown session. That is what makes rotating the secret a real invalidation.
      const session = await container.repositories.sessions.findActiveByTokenHash(
        hashSessionToken(raw),
      );
      if (!session) return next();

      const user = await container.repositories.users.findById(session.user_id as string);
      if (!user || user.status !== 'active') {
        // The session is valid but the principal is not: revoke it immediately.
        await container.repositories.sessions.revoke(session.id as string);
        return next();
      }

      req.auth = {
        user: toUserDTO(user),
        sessionId: session.id as string,
        csrfTokenHash: session.csrf_token_hash as string,
        expiresAt: new Date(session.expires_at as string | Date),
        organizationId: null,
      };
      patchRequestContext({ userId: user.id as string });

      // Sliding expiry: rotate the opaque token once it is older than the
      // configured interval so a stolen cookie has a bounded useful life.
      const config = getConfig();
      if (shouldRotateSession(new Date(session.rotated_at as string | Date), config)) {
        const rotated = await container.services.auth.rotateSession(session.id as string);
        setSessionCookies(res, config, rotated, rotated.expiresAt);
      }

      await container.repositories.sessions.touch(session.id as string);
      return next();
    } catch (error) {
      // A failure here must not silently authenticate anyone; log and continue
      // unauthenticated so the route rejects the request.
      logger.error({ err: error, requestId: req.requestId }, 'session resolution failed');
      return next();
    }
  };
}

/** Rejects the request unless a live session was resolved. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) return next(errors.unauthenticated());
  // An unverified address may browse, but the brief requires the account email to
  // be verified before it can spend credits or invite collaborators. That gate is
  // applied per-route via `requireVerifiedEmail`.
  return next();
}

/** Requires the authenticated account to have a verified email address. */
export function requireVerifiedEmail(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) return next(errors.unauthenticated());
  if (!req.auth.user.emailVerified) return next(errors.emailNotVerified());
  return next();
}
