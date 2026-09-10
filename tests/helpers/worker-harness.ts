/**
 * Worker harness for integration tests.
 *
 * Attaches the *real* worker handler table (`createWorkerHandlers`) to a *real*
 * BullMQ consumer backed by *real* Redis, so a test exercises the production job
 * lifecycle rather than a reimplementation of it. Nothing about job processing is
 * simulated: jobs are enqueued by the production services, travel through Redis,
 * and are executed by the same functions the deployed worker runs.
 */
import IORedis from 'ioredis';

import type { JobName } from '@zyvano/shared';
import type { Container } from '@zyvano/server/container';
import { createQueueConsumer, type JobHandler } from '@zyvano/server/infrastructure/queue/queue';

import { createWorkerHandlers } from '../../apps/worker/src/index';

export interface TestWorker {
  close(): Promise<void>;
}

/**
 * Starts a consumer bound to the same Redis prefix the application enqueues to.
 *
 * A fresh consumer is created per test so a test can control exactly when
 * processing becomes possible — which is what makes the cancellation test
 * deterministic rather than racing the worker.
 */
export async function startTestWorker(
  container: Container,
  concurrency = 2,
  /** Additional handlers, merged over the production table. */
  extraHandlers: Partial<Record<JobName, JobHandler>> = {},
): Promise<TestWorker> {
  const consumer = createQueueConsumer({
    redisUrl: container.config.redisUrl,
    prefix: container.config.worker.queuePrefix,
    concurrency,
    jobs: container.repositories.jobs,
  });

  const handlers = { ...createWorkerHandlers(container), ...extraHandlers };
  for (const [name, handler] of Object.entries(handlers)) {
    if (handler) consumer.register(name as JobName, handler);
  }

  await consumer.start();
  return {
    close: async () => {
      await consumer.close();
    },
  };
}

/**
 * Removes every Redis key under this run's queue prefix.
 *
 * The prefix is unique per test file, so this can never touch another process's
 * queues. Clearing before the suite starts prevents a job left over from an
 * earlier aborted run from being delivered into a test that did not create it.
 */
export async function resetQueues(container: Container): Promise<void> {
  const connection = new IORedis(container.config.redisUrl, { maxRetriesPerRequest: null });
  try {
    const pattern = `${container.config.worker.queuePrefix}:*`;
    let cursor = '0';
    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) await connection.del(...keys);
    } while (cursor !== '0');
  } finally {
    connection.disconnect();
  }
}

export interface WaitForOptions {
  /** Human-readable description of the awaited condition, used in the error. */
  label: string;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Polls `probe` until it returns a truthy value.
 *
 * Returns the value so callers can assert on it. On timeout the error names the
 * condition, because a bare "timed out" in this suite would be unactionable.
 */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  options: WaitForOptions,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${options.label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
