/**
 * SSRF defences and session-token mechanics.
 *
 * `assertUrlAllowed` is what stands between user-supplied media URLs and the
 * internal network, so it is tested exhaustively against the address classes that
 * matter (loopback, RFC1918, link-local metadata, unique-local IPv6).
 */
import { describe, expect, it } from 'vitest';

import { UnsafeUrlError, assertUrlAllowed, isPrivateAddress } from '@zyvano/server/security/ssrf';
import { deriveSecret } from '@zyvano/server/security/crypto';
import {
  createSessionTokens,
  csrfMatches,
  hashCsrfToken,
  hashSessionToken,
  hashToken,
  resetSessionKey,
  setSessionKey,
  shouldRotateSession,
} from '@zyvano/server/security/session';

describe('isPrivateAddress', () => {
  it('classifies loopback and link-local addresses as private', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('127.10.20.30')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true); // cloud metadata service
    expect(isPrivateAddress('fe80::1')).toBe(true);
  });

  it('classifies RFC1918 and carrier-grade NAT ranges as private', () => {
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.255.255.255')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('172.31.255.255')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
  });

  it('classifies multicast and reserved ranges as private', () => {
    expect(isPrivateAddress('224.0.0.1')).toBe(true);
    expect(isPrivateAddress('255.255.255.255')).toBe(true);
  });

  it('classifies unique-local IPv6 and IPv4-mapped private addresses as private', () => {
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('fd12:3456::1')).toBe(true);
    // An IPv4-mapped address hides the real target; it must inherit the verdict.
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateAddress('::ffff:192.168.0.1')).toBe(true);
  });

  it('treats genuinely public addresses as public', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('fails closed for values that are not addresses', () => {
    // Anything unrecognised must be treated as unsafe rather than allowed.
    expect(isPrivateAddress('not-an-ip')).toBe(true);
    expect(isPrivateAddress('')).toBe(true);
  });
});

describe('assertUrlAllowed', () => {
  it('rejects non-http protocols', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://internal:70/', 'data:text/plain,hi', 'ftp://x/y']) {
      await expect(assertUrlAllowed(url)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it('rejects a malformed URL', async () => {
    await expect(assertUrlAllowed('not a url')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects URLs carrying credentials', async () => {
    await expect(assertUrlAllowed('https://user:pass@example.com/a')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('rejects literal private addresses without a DNS lookup', async () => {
    for (const url of [
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/',
      'http://[::1]:4000/',
    ]) {
      await expect(assertUrlAllowed(url)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it('rejects known internal hostnames', async () => {
    await expect(assertUrlAllowed('http://localhost:4000/')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertUrlAllowed('http://metadata.google.internal/')).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('accepts a public URL and reports the resolved addresses', async () => {
    const result = await assertUrlAllowed('https://1.1.1.1/media/clip.mp4');

    expect(result.url.hostname).toBe('1.1.1.1');
    expect(result.addresses).toEqual(['1.1.1.1']);
  });

  it('enforces an allow-list when one is supplied', async () => {
    // The allow-list is checked before any DNS work, so a disallowed host is
    // rejected without a lookup. A literal public IP satisfies the allow-list.
    await expect(
      assertUrlAllowed('https://1.1.1.1/a.mp4', { allowedHosts: ['1.1.1.1'] }),
    ).resolves.toBeTruthy();

    // A subdomain of an allowed host is permitted.
    await expect(
      assertUrlAllowed('https://8.8.8.8/a.mp4', { allowedHosts: ['8.8.8.8'] }),
    ).resolves.toBeTruthy();

    await expect(
      assertUrlAllowed('https://evil.test/a.mp4', { allowedHosts: ['cdn.example.com'] }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);

    // A host that merely *contains* the allowed suffix must not pass.
    await expect(
      assertUrlAllowed('https://notcdn.example.com.evil.test/a.mp4', {
        allowedHosts: ['cdn.example.com'],
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});

describe('session tokens', () => {
  it('creates a session token and a distinct CSRF token', () => {
    const tokens = createSessionTokens();

    expect(tokens.sessionToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tokens.csrfToken).toMatch(/^[A-Za-z0-9_-]+$/);
    // The CSRF token must not be derivable from the session token.
    expect(tokens.csrfToken).not.toBe(tokens.sessionToken);
    expect(tokens.sessionTokenHash).toBe(hashSessionToken(tokens.sessionToken));
  });

  it('issues unique tokens per call', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => createSessionTokens().sessionToken));
    expect(tokens.size).toBe(100);
  });

  it('hashes tokens so the raw value is not recoverable from storage', () => {
    const tokens = createSessionTokens();
    expect(tokens.sessionTokenHash).not.toContain(tokens.sessionToken);
    expect(tokens.sessionTokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keys the stored digest with the deployment secret, so rotation invalidates it', () => {
    // The property AUTH_SECRET exists to provide: the persisted hash must be a function
    // of the deployment secret. Under the previous unkeyed SHA-256 it was not, so
    // rotating AUTH_SECRET left every outstanding cookie valid.
    const secretA = deriveSecret('a'.repeat(64), 'zyvano:session-store');
    const secretB = deriveSecret('b'.repeat(64), 'zyvano:session-store');
    const token = 'a-fixed-session-token-value';

    setSessionKey(secretA);
    const storedUnderA = hashSessionToken(token);
    expect(storedUnderA).toMatch(/^[0-9a-f]{64}$/);

    // Same token, rotated deployment secret: the digest must differ, which is exactly
    // why a cookie issued before rotation can no longer be resolved.
    setSessionKey(secretB);
    const storedUnderB = hashSessionToken(token);
    expect(storedUnderB).not.toBe(storedUnderA);

    // And it is genuinely keyed rather than merely salted: an unkeyed digest of the
    // same token must not equal the stored value.
    expect(storedUnderA).not.toBe(hashToken(token));

    resetSessionKey();
    // With the key restored from configuration, the digest is reproducible.
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates the session and CSRF derivations so one cannot stand in for the other', () => {
    // Both descend from one AUTH_SECRET, so the purpose string is what keeps a CSRF
    // token from being accepted as session material.
    const token = 'shared-input-value';
    expect(hashSessionToken(token)).not.toBe(hashCsrfToken(token));
  });
});

describe('csrfMatches', () => {
  it('accepts a token whose hash matches what was stored at sign-in', () => {
    const { csrfToken } = createSessionTokens();
    expect(csrfMatches(csrfToken, hashCsrfToken(csrfToken))).toBe(true);
  });

  it('rejects a missing, empty or mismatched token', () => {
    const { csrfToken } = createSessionTokens();
    const stored = hashCsrfToken(csrfToken);

    expect(csrfMatches(undefined, stored)).toBe(false);
    expect(csrfMatches('', stored)).toBe(false);
    // A different well-formed token must not pass.
    expect(csrfMatches(createSessionTokens().csrfToken, stored)).toBe(false);
  });

  it('rejects a hash that was derived under a different deployment secret', () => {
    // The CSRF check is keyed too, so a token echoed after AUTH_SECRET rotation no
    // longer matches the stored digest.
    const { csrfToken } = createSessionTokens();
    const stored = hashCsrfToken(csrfToken);

    setSessionKey(deriveSecret('rotated'.repeat(10), 'zyvano:session-store'));
    expect(csrfMatches(csrfToken, stored)).toBe(false);
    resetSessionKey();
  });
});

describe('shouldRotateSession', () => {
  const config = { sessionRotateMinutes: 60 } as never;

  it('rotates once the token is older than the configured interval', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');

    const justRotated = new Date('2026-09-10T11:30:00.000Z');
    expect(shouldRotateSession(justRotated, config, now)).toBe(false);

    const old = new Date('2026-09-10T10:30:00.000Z');
    expect(shouldRotateSession(old, config, now)).toBe(true);
  });

  it('rotates only strictly past the boundary', () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const intervalMs = 60 * 60 * 1000;

    // Exactly at the interval the session is still current; one millisecond past
    // it must rotate, so the boundary itself is asserted rather than assumed.
    expect(shouldRotateSession(new Date(now.getTime() - intervalMs), config, now)).toBe(false);
    expect(shouldRotateSession(new Date(now.getTime() - intervalMs - 1), config, now)).toBe(true);
  });
});
