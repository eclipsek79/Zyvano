/**
 * Session token handling.
 *
 * The browser holds two cookies:
 *   zyvano_session — opaque random token, HttpOnly, SameSite=Lax (Secure in prod)
 *   zyvano_csrf    — random CSRF token, readable by the SPA
 *
 * The database stores only hashes of both. Double-submit CSRF: the client echoes
 * the CSRF cookie in the `x-zyvano-csrf` header and the server compares it against
 * the stored hash using a constant-time comparison.
 *
 * Keying.
 *   Both digests are keyed with `deriveSecret(AUTH_SECRET, purpose)` rather than being
 *   a plain SHA-256 of the token. A bare digest is not a signature: it does not depend
 *   on any server-side secret, so rotating AUTH_SECRET had no effect on outstanding
 *   sessions and the field was validated at boot while buying nothing. Keying makes
 *   the persisted value a function of the deployment secret, so rotating AUTH_SECRET
 *   invalidates every cookie issued under the previous value while leaving the session
 *   rows intact for audit.
 */
import { createHash } from 'node:crypto';

import type { Response } from 'express';

import { COOKIE_NAMES, CSRF_HEADER } from '@zyvano/shared';

import type { AppConfig } from '../config/env';
import { getConfig } from '../config/env';
import { deriveSecret, generateToken, safeEqual } from './crypto';

/**
 * Derivation purposes.
 *
 * Distinct purpose strings keep the derived session key from being reusable in the
 * CSRF role (and vice versa) even though both descend from the same AUTH_SECRET.
 */
export const KEY_PURPOSE_SESSION = 'zyvano:session-token';
export const KEY_PURPOSE_CSRF = 'zyvano:csrf-token';

let cachedKey: string | null = null;

/**
 * The deployment key that every persisted session/CSRF hash is derived under.
 *
 * Resolved from validated configuration on first use and memoized. Deriving it here,
 * rather than requiring each call site to pass it through, is what makes a rotated
 * AUTH_SECRET take effect everywhere without a caller being able to forget it.
 */
function sessionKey(): string {
  if (cachedKey === null) {
    cachedKey = deriveSecret(getConfig().authSecret, 'zyvano:session-store');
  }
  return cachedKey;
}

/**
 * Overrides the derived key material.
 *
 * A test seam, mirroring `resetConfigCache` in `config/env`: it lets a suite change the
 * deployment secret within one process to assert that hashing is genuinely keyed. It
 * is never called by application code, which always reads the configured secret.
 */
export function setSessionKey(key: string): void {
  cachedKey = key;
}

/** Drops the memoized key so the next hash re-reads configuration. */
export function resetSessionKey(): void {
  cachedKey = null;
}

/** Keyed digest binding a token to this deployment's secret. */
function keyedHash(purpose: string, token: string): string {
  return createHash('sha256').update(`${purpose}:${sessionKey()}:${token}`).digest('hex');
}

/**
 * Hashes an opaque session token for storage.
 *
 * Keyed with AUTH_SECRET, so rotating the secret changes every digest computed from
 * that point on and therefore fails every previously issued cookie.
 */
export function hashSessionToken(token: string): string {
  return keyedHash(KEY_PURPOSE_SESSION, token);
}

/** Hashes a CSRF token, under its own purpose so the two are not interchangeable. */
export function hashCsrfToken(token: string): string {
  return keyedHash(KEY_PURPOSE_CSRF, token);
}

export interface SessionTokens {
  /** Raw session token — set as a cookie, never persisted in plaintext. */
  sessionToken: string;
  sessionTokenHash: string;
  /** Raw CSRF token — sent to the client, hash persisted. */
  csrfToken: string;
  csrfTokenHash: string;
}

export function createSessionTokens(): SessionTokens {
  const sessionToken = generateToken(32);
  const csrfToken = generateToken(24);
  return {
    sessionToken,
    sessionTokenHash: hashSessionToken(sessionToken),
    csrfToken,
    csrfTokenHash: hashCsrfToken(csrfToken),
  };
}

/**
 * Generic hash for single-use link tokens (email verification, password reset,
 * organization invitations).
 *
 * Deliberately unkeyed, and distinct from session hashing. These tokens are consumed
 * once against a row holding the same digest, so keying would add nothing, while a
 * rotation would invalidate links already sitting in users' inboxes mid-deploy.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Constant-time CSRF comparison against the stored hash. */
export function csrfMatches(providedToken: string | undefined, storedHash: string): boolean {
  if (!providedToken) return false;
  return safeEqual(hashCsrfToken(providedToken), storedHash);
}

function baseCookieOptions(config: AppConfig) {
  return {
    httpOnly: true as const,
    secure: config.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    ...(config.cookieDomain ? { domain: config.cookieDomain } : {}),
  };
}

/**
 * Writes the session + CSRF cookies. The CSRF cookie is intentionally readable by
 * JavaScript (double-submit pattern) while the session cookie is HttpOnly so an
 * XSS payload cannot exfiltrate the session itself.
 */
export function setSessionCookies(
  res: Response,
  config: AppConfig,
  tokens: Pick<SessionTokens, 'sessionToken' | 'csrfToken'>,
  expiresAt: Date,
): void {
  const maxAge = Math.max(0, expiresAt.getTime() - Date.now());

  res.cookie(COOKIE_NAMES.SESSION, tokens.sessionToken, {
    ...baseCookieOptions(config),
    expires: expiresAt,
    maxAge,
  });

  res.cookie(COOKIE_NAMES.CSRF, tokens.csrfToken, {
    ...baseCookieOptions(config),
    httpOnly: false,
    expires: expiresAt,
    maxAge,
  });
}

/** Clears both cookies (logout, session revocation, account deletion). */
export function clearSessionCookies(res: Response, config: AppConfig): void {
  const options = baseCookieOptions(config);
  res.clearCookie(COOKIE_NAMES.SESSION, options);
  res.clearCookie(COOKIE_NAMES.CSRF, { ...options, httpOnly: false });
}

export function sessionExpiry(config: AppConfig, from: Date = new Date()): Date {
  return new Date(from.getTime() + config.sessionTtlHours * 60 * 60 * 1000);
}

export function shouldRotateSession(rotatedAt: Date, config: AppConfig, now: Date = new Date()): boolean {
  return now.getTime() - rotatedAt.getTime() > config.sessionRotateMinutes * 60 * 1000;
}

export { CSRF_HEADER, COOKIE_NAMES };
