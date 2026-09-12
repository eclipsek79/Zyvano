/** Shared HTTP helpers for provider adapters. */
import { ProviderInvocationError } from './interfaces';

export interface FetchJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  provider: string;
  /** When the provider returns bytes rather than JSON. */
  expect: 'json' | 'binary';
}

async function request(
  url: string,
  options: FetchJsonOptions,
): Promise<{ response: Response; buffer: ArrayBuffer }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      method: options.method ?? 'POST',
      headers: {
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const buffer = await response.arrayBuffer();
    return { response, buffer };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new ProviderInvocationError(
      options.provider,
      aborted ? `Provider request timed out after ${options.timeoutMs}ms.` : message,
      { errorCode: aborted ? 'TIMEOUT' : 'NETWORK_ERROR', retryable: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions,
): Promise<{ data: T; httpStatus: number; externalRequestId: string | null }> {
  const { response, buffer } = await request(url, options);
  const text = Buffer.from(buffer).toString('utf8');

  if (!response.ok) {
    throw new ProviderInvocationError(
      options.provider,
      `Provider returned HTTP ${response.status}: ${text.slice(0, 500)}`,
      {
        httpStatus: response.status,
        errorCode: `HTTP_${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
        externalRequestId: response.headers.get('x-request-id'),
      },
    );
  }

  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    throw new ProviderInvocationError(options.provider, 'Provider returned malformed JSON.', {
      errorCode: 'MALFORMED_RESPONSE',
      retryable: false,
    });
  }

  return {
    data: parsed,
    httpStatus: response.status,
    externalRequestId: response.headers.get('x-request-id'),
  };
}

export async function fetchBinary(
  url: string,
  options: FetchJsonOptions,
): Promise<{ data: Buffer; mimeType: string; httpStatus: number }> {
  const { response, buffer } = await request(url, options);
  if (!response.ok) {
    const body = Buffer.from(buffer).toString('utf8').slice(0, 500);
    throw new ProviderInvocationError(
      options.provider,
      `Provider returned HTTP ${response.status}: ${body}`,
      {
        httpStatus: response.status,
        errorCode: `HTTP_${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
      },
    );
  }
  return {
    data: Buffer.from(buffer),
    mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
    httpStatus: response.status,
  };
}
