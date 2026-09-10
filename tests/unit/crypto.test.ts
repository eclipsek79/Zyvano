/**
 * Password hashing and token primitives.
 *
 * These are the highest-consequence functions in the platform: a regression here
 * either locks every user out or silently weakens stored credentials, so the
 * tests assert the security properties (salted, constant-time, self-describing
 * work factors) rather than just round-tripping.
 */
import { describe, expect, it } from 'vitest';

import {
  PASSWORD_HASH_PREFIX,
  deriveSecret,
  generateId,
  generateKeyPrefix,
  generateToken,
  hashPassword,
  passwordHashNeedsRehash,
  safeEqual,
  sha256,
  verifyPassword,
} from '@zyvano/server/security/crypto';

describe('password hashing', () => {
  it('produces a self-describing scrypt hash and verifies the password', async () => {
    const hash = await hashPassword('correct-horse-battery-42');

    expect(hash.startsWith(`${PASSWORD_HASH_PREFIX}$`)).toBe(true);
    expect(hash.split('$')).toHaveLength(6);
    await expect(verifyPassword('correct-horse-battery-42', hash)).resolves.toBe(true);
  });

  it('never stores the plaintext password in the hash', async () => {
    const password = 'sunflower-meadow-77';
    const hash = await hashPassword(password);

    expect(hash).not.toContain(password);
    expect(Buffer.from(hash, 'utf8').toString('utf8')).not.toContain(password);
  });

  it('salts each hash so identical passwords produce different digests', async () => {
    const [first, second] = await Promise.all([
      hashPassword('identical-password-1'),
      hashPassword('identical-password-1'),
    ]);

    expect(first).not.toBe(second);
    // Both must still verify: the salt is embedded, not dropped.
    await expect(verifyPassword('identical-password-1', first)).resolves.toBe(true);
    await expect(verifyPassword('identical-password-1', second)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('the-real-password-9');
    await expect(verifyPassword('the-wrong-password-9', hash)).resolves.toBe(false);
  });

  it('returns false for malformed stored hashes instead of throwing', async () => {
    const malformed = [
      '',
      'not-a-hash',
      'scrypt$only$three$parts',
      'bcrypt$16384$8$1$c2FsdA$aGFzaA',
      'scrypt$notanumber$8$1$c2FsdA$aGFzaA',
    ];

    for (const stored of malformed) {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    }
  });

  it('flags hashes that were produced with weaker work factors', async () => {
    const current = await hashPassword('some-password-12');
    expect(passwordHashNeedsRehash(current)).toBe(false);

    // A hash recorded with a lower N must be rehashed on next successful login.
    const parts = current.split('$');
    const weakened = `scrypt$2$8$1$${parts[4]}$${parts[5]}`;
    expect(passwordHashNeedsRehash(weakened)).toBe(true);
    expect(passwordHashNeedsRehash('garbage')).toBe(true);
  });
});

describe('safeEqual', () => {
  it('matches equal values and rejects differing ones', () => {
    expect(safeEqual('token-value', 'token-value')).toBe(true);
    expect(safeEqual('token-value', 'token-valuf')).toBe(false);
  });

  it('rejects values of different length without throwing', () => {
    // timingSafeEqual throws on length mismatch; the wrapper must guard it.
    expect(safeEqual('short', 'a-much-longer-value')).toBe(false);
  });

  it('compares buffers as well as strings', () => {
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abc'))).toBe(true);
    expect(safeEqual(Buffer.from('abc'), Buffer.from('abd'))).toBe(false);
  });
});

describe('token generation', () => {
  it('produces unique, url-safe tokens with the requested entropy', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateToken(16)));

    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      // base64url alphabet only: safe to place in a URL or a cookie value.
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces unique identifiers', () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateId()));
    expect(ids.size).toBe(500);
  });

  it('formats API key prefixes with the documented marker', () => {
    expect(generateKeyPrefix()).toMatch(/^zyk_[0-9a-f]{12}$/);
  });
});

describe('sha256', () => {
  it('is deterministic and hex encoded', () => {
    const digest = sha256('session-token');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256('session-token')).toBe(digest);
  });

  it('differs for different inputs', () => {
    expect(sha256('token-a')).not.toBe(sha256('token-b'));
  });
});

describe('deriveSecret', () => {
  it('derives a stable key per purpose and separates purposes', () => {
    const secret = 'a'.repeat(64);

    expect(deriveSecret(secret, 'email-verification')).toBe(
      deriveSecret(secret, 'email-verification'),
    );
    // The same secret must not yield the same key for a different purpose.
    expect(deriveSecret(secret, 'email-verification')).not.toBe(
      deriveSecret(secret, 'password-reset'),
    );
    expect(deriveSecret(secret, 'password-reset')).not.toBe(
      deriveSecret('b'.repeat(64), 'password-reset'),
    );
  });
});
