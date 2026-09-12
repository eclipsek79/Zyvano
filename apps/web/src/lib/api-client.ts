/**
 * Typed HTTP client for the Zyvano API.
 *
 * Responsibilities kept in one place so no component ever hand-rolls a fetch:
 *  - attaches the session cookie (`credentials: include`),
 *  - echoes the CSRF cookie in the `x-zyvano-csrf` header on state-changing
 *    methods, which is the double-submit pair the API verifies,
 *  - sends the active organization header so every tenant-scoped request is
 *    resolved server-side rather than inferred client-side,
 *  - normalizes the error envelope into a typed `ApiError` carrying the code,
 *    field details, retryability and request id,
 *  - surfaces a session-expiry callback exactly once so the shell can redirect
 *    instead of every caller guessing.
 */
import {
  CSRF_HEADER,
  ERROR_CODES,
  type ErrorCode,
  type ErrorDetail,
  type ListResponse,
  type PaginationMeta,
  type SerializedError,
} from '@zyvano/shared';

const ORG_HEADER = 'x-zyvano-organization';
const CSRF_COOKIE = 'zyvano_csrf';

/** Base path of the versioned API. Same-origin by design. */
export const API_BASE = '/api/v1';

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[];
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(input: {
    code: ErrorCode;
    message: string;
    status: number;
    details?: ErrorDetail[];
    retryable?: boolean;
    requestId?: string | null;
  }) {
    super(input.message);
    this.name = 'ApiError';
    this.code = input.code;
    this.status = input.status;
    this.details = input.details ?? [];
    this.retryable = input.retryable ?? false;
    this.requestId = input.requestId ?? null;
  }

  /** Field errors keyed by field name, for inline form display. */
  fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const detail of this.details) {
      if (detail.field) map[detail.field] = detail.message;
    }
    return map;
  }

  isAuthenticationRequired(): boolean {
    return (
      this.status === 401 ||
      this.code === ERROR_CODES.AUTHENTICATION_REQUIRED ||
      this.code === ERROR_CODES.SESSION_EXPIRED
    );
  }
}

/** Reads a cookie by name. Returns null when the cookie is absent. */
function readCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  /** Overrides the active organization for this single request. */
  organizationId?: string | null;
  /**
   * Additional headers for this request only.
   *
   * Used for endpoint-specific guards, such as the `x-zyvano-confirm` header a
   * destructive project delete must carry.
   */
  extraHeaders?: Record<string, string>;
  signal?: AbortSignal;
}

let activeOrganizationId: string | null = null;
let onSessionExpired: (() => void) | null = null;

/** Sets the organization every subsequent request is scoped to. */
export function setActiveOrganizationId(id: string | null): void {
  activeOrganizationId = id;
}

export function getActiveOrganizationId(): string | null {
  return activeOrganizationId;
}

/** Registers the callback fired when the server reports the session is gone. */
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  onSessionExpired = handler;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${API_BASE}${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

function isStateChanging(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/**
 * Performs a JSON request. Throws `ApiError` for any non-2xx response, so callers
 * only ever handle one failure type and can switch on `code`.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const organizationId = options.organizationId ?? activeOrganizationId;
  if (organizationId) headers[ORG_HEADER] = organizationId;

  if (isStateChanging(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) headers[CSRF_HEADER] = csrf;
  }

  if (options.extraHeaders) {
    for (const [key, value] of Object.entries(options.extraHeaders)) headers[key] = value;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // A transport failure is not an API error: report it as a retryable
    // infrastructure problem rather than pretending the server rejected us.
    throw new ApiError({
      code: ERROR_CODES.INFRASTRUCTURE_ERROR,
      message: 'Could not reach the Zyvano API. Check your connection and retry.',
      status: 0,
      retryable: true,
    });
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? safeJsonParse(text) : null;

  if (!response.ok) {
    const envelope = (payload as SerializedError | null)?.error;
    const apiError = new ApiError({
      code: (envelope?.code as ErrorCode) ?? ERROR_CODES.INTERNAL_ERROR,
      message: envelope?.message ?? `Request failed with status ${response.status}.`,
      status: response.status,
      ...(envelope?.details ? { details: envelope.details } : {}),
      retryable: envelope?.retryable ?? response.status >= 500,
      requestId: envelope?.requestId ?? response.headers.get('x-request-id'),
    });

    if (apiError.isAuthenticationRequired() && onSessionExpired) onSessionExpired();
    throw apiError;
  }

  return payload as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Envelope helpers                                                            */
/* -------------------------------------------------------------------------- */

/** Unwraps `{ data }` from a single-resource response. */
export async function requestItem<T>(path: string, options?: RequestOptions): Promise<T> {
  const payload = await request<{ data: T }>(path, options);
  return payload.data;
}

/** Unwraps `{ data, meta }` from a list response. */
export async function requestList<T>(
  path: string,
  options?: RequestOptions,
): Promise<{ items: T[]; meta: PaginationMeta }> {
  const payload = await request<ListResponse<T>>(path, options);
  return { items: payload.data, meta: payload.meta };
}

/** Returns the raw response for callers that need the unwrapped envelope. */
export async function requestRaw<T>(path: string, options?: RequestOptions): Promise<T> {
  return request<T>(path, options);
}

export { request as apiRequest };
