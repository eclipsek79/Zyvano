/**
 * Authentication API.
 *
 * Drives the real Express application over HTTP against a real database, so the
 * tests cover the whole chain: validation → service → hashing → session creation
 * → cookie emission. Cookie flags and CSRF are asserted explicitly because they
 * are the parts a functional test would otherwise miss.
 */
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { COOKIE_NAMES } from '@zyvano/shared';

import { buildTestApp, closeHarness, resetDatabase } from '../helpers/app';

const app = buildTestApp();

/**
 * Extracts a cookie value from a supertest response.
 *
 * The value is split on the FIRST `=` only: session and CSRF tokens are base64url
 * and may legitimately contain `=` padding, which a naive `split('=')` would
 * truncate — producing a token that looks plausible but never matches.
 */
function cookieValue(response: request.Response, name: string): string | undefined {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  if (!raw) return undefined;
  for (const entry of raw) {
    const separator = entry.indexOf('=');
    if (separator === -1) continue;
    const key = entry.slice(0, separator);
    if (key !== name) continue;
    const rest = entry.slice(separator + 1);
    const terminator = rest.indexOf(';');
    return terminator === -1 ? rest : rest.slice(0, terminator);
  }
  return undefined;
}

function cookieHeader(response: request.Response): string {
  const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
  return (raw ?? [])
    .map((entry) => entry.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

const VALID = {
  email: 'ada@example.com',
  password: 'lovelace-analytical1',
  displayName: 'Ada Lovelace',
};

async function registerUser(overrides: Partial<typeof VALID> = {}) {
  return request(app)
    .post('/api/v1/auth/register')
    .send({ ...VALID, ...overrides })
    .set('user-agent', 'vitest');
}

/**
 * Marks an account's email as verified.
 *
 * The raw verification token is only ever delivered by email, so a test cannot
 * obtain it through the API. Arranging the verified state directly keeps the
 * suites that are *not* about verification readable; the verification flow itself
 * is asserted on its own in `tests/api/auth.test.ts` and `tests/integration`.
 */
async function markEmailVerified(email: string): Promise<void> {
  const { getPool } = await import('@zyvano/server/db/pool');
  await getPool().query('UPDATE users SET email_verified_at = now() WHERE email = $1', [email]);
}

/** Registers an account and marks it verified, for suites that need to generate. */
async function registerVerifiedUser(overrides: Partial<typeof VALID> = {}) {
  const response = await registerUser(overrides);
  await markEmailVerified(overrides.email ?? VALID.email);
  return response;
}

beforeAll(async () => {
  await resetDatabase();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await closeHarness();
});

describe('POST /api/v1/auth/register', () => {
  it('creates the account, its workspace and a session', async () => {
    const response = await registerUser();

    expect(response.status).toBe(201);
    expect(response.body.data.user.email).toBe('ada@example.com');
    expect(response.body.data.user.displayName).toBe('Ada Lovelace');
    // A brand new account has not confirmed its address yet.
    expect(response.body.data.user.emailVerified).toBe(false);
    // Registration creates a personal workspace so the account is never orphaned.
    expect(response.body.data.organizations).toHaveLength(1);
    expect(response.body.data.organizations[0].role).toBe('owner');
    expect(response.body.data.csrfToken).toBeTruthy();
  });

  it('never returns the password hash or the raw session token in the body', async () => {
    const response = await registerUser({ email: 'leak-check@example.com' });
    const serialized = JSON.stringify(response.body);

    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('scrypt$');
    expect(serialized).not.toContain('passwordHash');
    // The CSRF token is intentionally exposed to the client; the session token is
    // not, and must only ever travel as an httpOnly cookie.
    const sessionCookie = cookieValue(response, COOKIE_NAMES.SESSION);
    expect(sessionCookie).toBeTruthy();
    expect(serialized).not.toContain(sessionCookie);
  });

  it('sets an httpOnly session cookie and a readable CSRF cookie', async () => {
    const response = await registerUser({ email: 'cookies@example.com' });
    const raw = (response.headers['set-cookie'] as unknown as string[]) ?? [];

    const session = raw.find((entry) => entry.startsWith(`${COOKIE_NAMES.SESSION}=`));
    const csrf = raw.find((entry) => entry.startsWith(`${COOKIE_NAMES.CSRF}=`));

    expect(session).toBeDefined();
    expect(csrf).toBeDefined();

    // The session cookie must be unreadable from JavaScript.
    expect(session?.toLowerCase()).toContain('httponly');
    expect(session?.toLowerCase()).toContain('samesite');
    // The CSRF cookie must be JS-readable: the client echoes it back in a header.
    expect(csrf?.toLowerCase()).not.toContain('httponly');
  });

  it('rejects a duplicate email with a conflict', async () => {
    await registerUser();
    const second = await registerUser({ displayName: 'Impostor' });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('CONFLICT');
  });

  it('treats email as case-insensitive for uniqueness', async () => {
    await registerUser();
    const upper = await registerUser({ email: 'ADA@EXAMPLE.COM' });

    expect(upper.status).toBe(409);
  });

  it('rejects a weak password with a field-level validation error', async () => {
    const response = await registerUser({ email: 'weak@example.com', password: 'short' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details.some((d: { field?: string }) => d.field === 'password')).toBe(
      true,
    );
  });

  it('rejects a malformed email', async () => {
    const response = await registerUser({ email: 'not-an-email' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('provides a request id for support correlation', async () => {
    const response = await registerUser({ email: 'trace@example.com' });
    expect(response.body.data).toBeDefined();
    expect(response.headers['x-request-id']).toBeTruthy();
  });
});

describe('POST /api/v1/auth/login', () => {
  beforeEach(async () => {
    await registerUser();
  });

  it('signs in with correct credentials', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email, password: VALID.password });

    expect(response.status).toBe(200);
    expect(response.body.data.user.email).toBe(VALID.email);
    expect(cookieValue(response, COOKIE_NAMES.SESSION)).toBeTruthy();
  });

  it('accepts the email in any case', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email.toUpperCase(), password: VALID.password });

    expect(response.status).toBe(200);
  });

  it('rejects a wrong password without revealing which field was wrong', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email, password: 'wrong-password-1' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('returns the same error for an unknown account as for a wrong password', async () => {
    // Differing responses would let an attacker enumerate registered addresses.
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever-pass1' });

    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email, password: 'whatever-pass1' });

    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body.error.code).toBe(wrong.body.error.code);
  });

  it('does not authenticate a session whose account is suspended', async () => {
    const { getPool } = await import('@zyvano/server/db/pool');
    await getPool().query("UPDATE users SET status = 'suspended' WHERE email = $1", [VALID.email]);

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: VALID.email, password: VALID.password });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('requires a session', async () => {
    const response = await request(app).get('/api/v1/auth/me');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('returns the live session for a valid cookie', async () => {
    const registration = await registerUser({ email: 'me@example.com' });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookieHeader(registration));

    expect(response.status).toBe(200);
    expect(response.body.data.user.email).toBe('me@example.com');
  });

  it('rejects a forged session cookie', async () => {
    await registerUser({ email: 'me2@example.com' });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', `${COOKIE_NAMES.SESSION}=forged-token-value`);

    expect(response.status).toBe(401);
  });

  it('rejects an expired session even though the token is valid', async () => {
    const registration = await registerUser({ email: 'expired@example.com' });
    const { getPool } = await import('@zyvano/server/db/pool');

    await getPool().query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute'
       WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      ['expired@example.com'],
    );

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookieHeader(registration));

    expect(response.status).toBe(401);
  });

  it('rejects a revoked session', async () => {
    const registration = await registerUser({ email: 'revoked@example.com' });
    const { getPool } = await import('@zyvano/server/db/pool');

    await getPool().query(
      `UPDATE sessions SET revoked_at = now()
       WHERE user_id = (SELECT id FROM users WHERE email = $1)`,
      ['revoked@example.com'],
    );

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Cookie', cookieHeader(registration));

    expect(response.status).toBe(401);
  });
});

describe('CSRF protection', () => {
  it('rejects a state-changing request without the CSRF header', async () => {
    const registration = await registerUser({ email: 'csrf@example.com' });

    const response = await request(app)
      .post('/api/v1/projects')
      .set('Cookie', cookieHeader(registration))
      .send({ name: 'Should not be created' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects a request whose CSRF header does not match the cookie', async () => {
    const registration = await registerUser({ email: 'csrf2@example.com' });

    const response = await request(app)
      .post('/api/v1/projects')
      .set('Cookie', cookieHeader(registration))
      .set('x-zyvano-csrf', 'not-the-real-token')
      .send({ name: 'Should not be created' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('CSRF_INVALID');
  });

  it('accepts a request carrying the matching CSRF token', async () => {
    const registration = await registerVerifiedUser({ email: 'csrf3@example.com' });
    const csrf = cookieValue(registration, COOKIE_NAMES.CSRF);

    const response = await request(app)
      .post('/api/v1/projects')
      .set('Cookie', cookieHeader(registration))
      .set('x-zyvano-csrf', csrf ?? '')
      .send({ name: 'A real project' });

    expect(response.status).toBe(201);
    expect(response.body.data.name).toBe('A real project');
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('clears the session so the cookie can no longer authenticate', async () => {
    const registration = await registerUser({ email: 'logout@example.com' });
    const csrf = cookieValue(registration, COOKIE_NAMES.CSRF);
    const cookies = cookieHeader(registration);

    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('Cookie', cookies)
      .set('x-zyvano-csrf', csrf ?? '');
    expect(logout.status).toBeLessThan(300);

    const after = await request(app).get('/api/v1/auth/me').set('Cookie', cookies);
    expect(after.status).toBe(401);

    // The session row is revoked, not merely deleted from the client.
    const { getPool } = await import('@zyvano/server/db/pool');
    const result = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sessions
       WHERE revoked_at IS NULL
         AND user_id = (SELECT id FROM users WHERE email = $1)`,
      ['logout@example.com'],
    );
    expect(result.rows[0]?.count).toBe('0');
  });
});

describe('email verification gate', () => {
  it('blocks project creation until the address is verified', async () => {
    const registration = await registerUser({ email: 'unverified@example.com' });
    const csrf = cookieValue(registration, COOKIE_NAMES.CSRF);

    const blocked = await request(app)
      .post('/api/v1/projects')
      .set('Cookie', cookieHeader(registration))
      .set('x-zyvano-csrf', csrf ?? '')
      .send({ name: 'Blocked project' });

    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('EMAIL_NOT_VERIFIED');

    // Once verified, the same request succeeds — the gate is the verification
    // state, not a permanent refusal.
    await markEmailVerified('unverified@example.com');

    const allowed = await request(app)
      .post('/api/v1/projects')
      .set('Cookie', cookieHeader(registration))
      .set('x-zyvano-csrf', csrf ?? '')
      .send({ name: 'Allowed project' });

    expect(allowed.status).toBe(201);
  });

  it('rejects an unknown verification token', async () => {
    const response = await request(app)
      .post('/api/v1/auth/email/verify')
      .send({ token: 'not-a-real-token-value' });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('unauthenticated access', () => {
  it('refuses every protected collection without a session', async () => {
    const paths = [
      '/api/v1/projects',
      '/api/v1/assets',
      '/api/v1/generations',
      '/api/v1/exports',
      '/api/v1/organizations',
      '/api/v1/usage',
      '/api/v1/audit',
      '/api/v1/notifications',
    ];

    for (const path of paths) {
      const response = await request(app).get(path);
      expect(response.status, `${path} should require authentication`).toBe(401);
    }
  });
});
