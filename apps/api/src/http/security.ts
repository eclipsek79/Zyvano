/**
 * Security middleware: headers, CORS and CSRF.
 *
 * CORS is an allow-list (the configured application origin), credentials are
 * enabled so the session cookie is sent, and CSRF uses the double-submit
 * pattern: the readable `zyvano_csrf` cookie must be echoed in the
 * `x-zyvano-csrf` header on every state-changing request.
 */
import cors from 'cors';
import type { Application, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

import { CSRF_HEADER, COOKIE_NAMES, errors } from '@zyvano/shared';

import { getConfig } from '@zyvano/server/config/env';
import { csrfMatches } from '@zyvano/server/security/session';

/** Methods that do not mutate state and are therefore CSRF-exempt. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Endpoints reachable without a session. They cannot be CSRF-protected because
 * no CSRF token exists yet; they are instead rate-limited and validate the
 * origin of the request.
 */
const CSRF_EXEMPT_PATHS = new Set([
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/password/forgot',
  '/api/v1/auth/password/reset',
  '/api/v1/auth/email/verify',
]);

export function applySecurityHeaders(app: Application): void {
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          // The API serves JSON only; lock the document surface down entirely.
          'default-src': ["'none'"],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: getConfig().isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // Defence in depth: strip the framework fingerprint.
  app.disable('x-powered-by');
}

export function applyCors(app: Application): void {
  const { applicationUrl, isProduction } = getConfig();

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin / server-to-server requests have no Origin header.
        if (!origin) return callback(null, true);
        if (origin === applicationUrl) return callback(null, true);
        // Local development tolerates the Vite dev server on any localhost port.
        if (!isProduction && /^https?:\/\/localhost(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['content-type', CSRF_HEADER, 'x-zyvano-organization', 'x-request-id'],
      exposedHeaders: ['x-request-id'],
      maxAge: 600,
    }),
  );
}

/**
 * Double-submit CSRF verification. Runs after the session middleware so the
 * stored token hash is available.
 */
export function verifyCsrf(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();
  if (CSRF_EXEMPT_PATHS.has(req.path)) return next();

  // A request with no session has nothing to forge; the route itself will
  // reject it as unauthenticated.
  if (!req.auth) return next();

  const provided = req.header(CSRF_HEADER);
  if (!csrfMatches(provided, req.auth.csrfTokenHash)) {
    return next(errors.csrf());
  }
  return next();
}

export { COOKIE_NAMES, CSRF_HEADER };
