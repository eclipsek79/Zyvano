/**
 * SSRF defence.
 *
 * Zyvano accepts media URLs from users only as *references*; whenever the server
 * must fetch a URL itself (importing a reference image, pulling a provider
 * result) it goes through `assertUrlAllowed` first.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
]);

/** RFC1918 / loopback / link-local / CGNAT / reserved ranges. */
function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80')) return true; // link-local
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
    // IPv4-mapped IPv6
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

/**
 * Validates a URL for server-side fetching:
 *  - http/https only (no file:, gopher:, data:)
 *  - no credentials in the URL
 *  - hostname must not resolve to a private/loopback/link-local address
 * Returns the resolved IPs so callers can pin them if desired.
 */
export async function assertUrlAllowed(
  rawUrl: string,
  options: { allowedHosts?: readonly string[] } = {},
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('Malformed URL.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError(`Protocol "${url.protocol}" is not allowed.`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError('URLs containing credentials are not allowed.');
  }
  if (BLOCKED_HOSTNAMES.has(url.hostname.toLowerCase())) {
    throw new UnsafeUrlError('Refusing to fetch an internal hostname.');
  }

  if (options.allowedHosts && options.allowedHosts.length > 0) {
    const allowed = options.allowedHosts.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
    if (!allowed) throw new UnsafeUrlError(`Host "${url.hostname}" is not in the allow-list.`);
  }

  // Literal IPs are checked directly; hostnames are resolved and every answer
  // must be public (defends against DNS rebinding to a private address).
  //
  // A URL's `hostname` keeps the brackets around an IPv6 literal, and `net.isIP`
  // does not accept them — so the brackets are stripped first. Without this an
  // IPv6 literal such as `[::1]` would skip the literal check entirely and only
  // be rejected later by a failed DNS lookup, which is the wrong reason and would
  // stop classifying it as a private address.
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UnsafeUrlError('Refusing to fetch a private address.');
    return { url, addresses: [host] };
  }

  const records = await lookup(host, { all: true });
  if (records.length === 0) throw new UnsafeUrlError('Hostname did not resolve.');
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new UnsafeUrlError('Hostname resolves to a private address.');
    }
  }
  return { url, addresses: records.map((record) => record.address) };
}

export { isPrivateAddress };
