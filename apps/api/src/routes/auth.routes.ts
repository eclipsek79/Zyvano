/**
 * Authentication routes: /api/v1/auth
 *
 * These endpoints are unauthenticated by design and are therefore the most
 * tightly rate-limited surface in the API. Every response that establishes a
 * session writes the cookie pair; every response that ends one clears it.
 */
import { Router } from 'express';

import {
  COOKIE_NAMES,
  changePasswordSchema,
  errors,
  loginSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  type AuthSessionDTO,
} from '@zyvano/shared';

import type { Container } from '@zyvano/server/container';
import { getConfig } from '@zyvano/server/config/env';
import { setSessionCookies, clearSessionCookies } from '@zyvano/server/security/session';

import { asyncHandler } from '../http/errors';
import { ok, noContent } from '../http/respond';
import { createRateLimiters } from '../http/rate-limit';
import { parseBody } from '../http/validate';
import { requireAuth } from '../middleware/auth';

export function createAuthRouter(container: Container, limiters: ReturnType<typeof createRateLimiters>): Router {
  const router = Router();
  const config = getConfig();

  /** Builds the session payload the SPA stores in its auth context. */
  const sessionPayload = async (input: {
    userId: string;
    csrfToken: string;
    expiresAt: Date;
  }): Promise<AuthSessionDTO> => container.services.auth.buildSessionPayload(input);

  router.post(
    '/register',
    limiters.auth,
    asyncHandler(async (req, res) => {
      const body = parseBody(registerSchema, req);
      const result = await container.services.auth.register({
        email: body.email,
        password: body.password,
        displayName: body.displayName,
        organizationName: body.organizationName,
        ipAddress: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      });

      setSessionCookies(res, config, result.session, result.session.expiresAt);
      res.status(201).json({
        data: await sessionPayload({
          userId: result.user.id,
          csrfToken: result.session.csrfToken,
          expiresAt: result.session.expiresAt,
        }),
      });
    }),
  );

  router.post(
    '/login',
    limiters.auth,
    asyncHandler(async (req, res) => {
      const body = parseBody(loginSchema, req);
      const result = await container.services.auth.login({
        email: body.email,
        password: body.password,
        ipAddress: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
      });

      setSessionCookies(res, config, result.session, result.session.expiresAt);
      ok(
        res,
        await sessionPayload({
          userId: result.user.id,
          csrfToken: result.session.csrfToken,
          expiresAt: result.session.expiresAt,
        }),
      );
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      if (req.auth) {
        await container.services.auth.logout(req.auth.sessionId, req.auth.user.id);
      }
      clearSessionCookies(res, config);
      noContent(res);
    }),
  );

  /** Returns the current session, refreshing organization membership. */
  router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) throw errors.unauthenticated();
      ok(
        res,
        await sessionPayload({
          userId: auth.user.id,
          csrfToken: req.cookies?.[COOKIE_NAMES.CSRF] ?? '',
          expiresAt: auth.expiresAt,
        }),
      );
    }),
  );

  router.post(
    '/email/verify',
    limiters.auth,
    asyncHandler(async (req, res) => {
      const body = parseBody(verifyEmailSchema, req);
      await container.services.auth.verifyEmail(body.token);
      noContent(res);
    }),
  );

  /** Re-sends the verification email for the authenticated account. */
  router.post(
    '/email/resend',
    limiters.auth,
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) throw errors.unauthenticated();
      if (auth.user.emailVerified) throw errors.conflict('This email address is already verified.');
      await container.services.auth.sendVerificationEmail(
        auth.user.id,
        auth.user.email,
        auth.user.displayName,
      );
      noContent(res);
    }),
  );

  router.post(
    '/password/forgot',
    limiters.auth,
    asyncHandler(async (req, res) => {
      const body = parseBody(requestPasswordResetSchema, req);
      await container.services.auth.requestPasswordReset(body.email);
      // Always 204: the response must not reveal whether the address exists.
      noContent(res);
    }),
  );

  router.post(
    '/password/reset',
    limiters.auth,
    asyncHandler(async (req, res) => {
      const body = parseBody(resetPasswordSchema, req);
      await container.services.auth.resetPassword(body.token, body.password);
      noContent(res);
    }),
  );

  router.post(
    '/password/change',
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) throw errors.unauthenticated();
      const body = parseBody(changePasswordSchema, req);
      await container.services.auth.changePassword({
        userId: auth.user.id,
        currentPassword: body.currentPassword,
        newPassword: body.newPassword,
        keepSessionId: auth.sessionId,
      });
      noContent(res);
    }),
  );

  /** Revokes every session for the account, including the current one. */
  router.post(
    '/sessions/revoke-all',
    requireAuth,
    asyncHandler(async (req, res) => {
      const auth = req.auth;
      if (!auth) throw errors.unauthenticated();
      await container.services.auth.revokeAllSessions(auth.user.id);
      clearSessionCookies(res, config);
      noContent(res);
    }),
  );

  return router;
}
