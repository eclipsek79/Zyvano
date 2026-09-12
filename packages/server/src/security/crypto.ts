/**
 * Cryptographic primitives.
 *
 *  - Passwords are hashed with scrypt (memory-hard) using a per-password salt and
 *    a versioned encoding, so the parameters can be raised later without
 *    invalidating existing hashes.
 *  - Opaque tokens (sessions, email verification, password reset, API keys) are
 *    stored only as SHA-256 hashes.
 *  - All comparisons are constant-time.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

/** Current scrypt work factors. Stored in the hash so they can be upgraded. */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
/** scrypt needs ~128*N*r bytes; give it headroom to avoid ERR_CRYPTO_INVALID_SCRYPT_PARAMS. */
const MAX_MEM = 128 * SCRYPT_PARAMS.N * SCRYPT_PARAMS.r * 2;

export const PASSWORD_HASH_PREFIX = 'scrypt';

/** Produces `scrypt$N$r$p$salt$hash`, all base64url encoded. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scrypt(password, salt, KEY_LENGTH, { ...SCRYPT_PARAMS, maxmem: MAX_MEM });
  return [
    PASSWORD_HASH_PREFIX,
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash. Returns false (never throws) for
 * malformed hashes so a corrupt row cannot be used to probe the parser.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    if (parts.length !== 6) return false;
    const [prefix, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (prefix !== PASSWORD_HASH_PREFIX) return false;

    const N = Number.parseInt(nRaw, 10);
    const r = Number.parseInt(rRaw, 10);
    const p = Number.parseInt(pRaw, 10);
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

    const salt = Buffer.from(saltRaw, 'base64url');
    const expected = Buffer.from(hashRaw, 'base64url');
    const derived = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
    return safeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Returns true when a stored hash uses work factors below the current target. */
export function passwordHashNeedsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6) return true;
  const [, nRaw, rRaw, pRaw] = parts;
  return (
    Number.parseInt(nRaw ?? '0', 10) < SCRYPT_PARAMS.N ||
    Number.parseInt(rRaw ?? '0', 10) < SCRYPT_PARAMS.r ||
    Number.parseInt(pRaw ?? '0', 10) < SCRYPT_PARAMS.p
  );
}

/** Constant-time buffer comparison that tolerates differing lengths. */
export function safeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const bufA = typeof a === 'string' ? Buffer.from(a, 'utf8') : a;
  const bufB = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** SHA-256 hex digest, used for storing opaque tokens. */
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** URL-safe random token with `bytes` of entropy. */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function generateId(): string {
  return randomUUID();
}

/** Short, URL-safe identifier used for API key prefixes. */
export function generateKeyPrefix(): string {
  return `zyk_${randomBytes(6).toString('hex')}`;
}

/** Derives a stable key from AUTH_SECRET for non-password signing needs. */
export function deriveSecret(secret: string, purpose: string): string {
  return createHash('sha256').update(`${purpose}:${secret}`).digest('hex');
}
