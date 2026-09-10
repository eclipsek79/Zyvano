/**
 * Async-local per-request context used to correlate logs, audit events and
 * job payloads with the HTTP request that produced them.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  userId: string | null;
  organizationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function patchRequestContext(patch: Partial<RequestContext>): void {
  const current = storage.getStore();
  if (!current) return;
  Object.assign(current, patch);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
