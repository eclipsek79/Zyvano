/**
 * Background job queue abstraction.
 *
 * BullMQ (Redis) backs the live queue. The abstraction exists so the API never
 * depends on BullMQ types directly and so tests can drive jobs synchronously.
 *
 * Every enqueue also writes a durable `jobs` row, which is what the UI reads and
 * what operators replay from when a worker dies mid-job.
 */
import { Queue, QueueEvents, Worker, type JobsOptions } from 'bullmq';
import IORedis from 'ioredis';

import { JOB_QUEUE_MAP, QUEUE_NAMES, type JobName, type QueueName } from '@zyvano/shared';

import { logger } from '../../observability/logger';
import type { JobRepository } from '../../repositories/job-repository';

export interface EnqueueOptions {
  /** Dedupe key: only one live job per (name, key). */
  dedupeKey?: string | undefined;
  delayMs?: number | undefined;
  maxAttempts?: number | undefined;
  organizationId?: string | null;
  projectId?: string | null;
  generationId?: string | null;
  exportId?: string | null;
}

export interface QueueService {
  enqueue<T extends Record<string, unknown>>(
    name: JobName,
    payload: T,
    options?: EnqueueOptions,
  ): Promise<{ jobId: string; queueName: QueueName }>;
  /** Removes a queued job (used on cancellation). */
  cancel(jobId: string): Promise<boolean>;
  setProgress(jobId: string, progress: number): Promise<void>;
  health(): Promise<{ ok: boolean; queues: number; error?: string }>;
  close(): Promise<void>;
}

/** Payload every dispatched job carries, regardless of its specific handler. */
export interface JobEnvelope {
  /** Primary key of the durable `jobs` row; the correlation id for the whole run. */
  __jobRowId?: string | undefined;
  organizationId?: string | null;
  projectId?: string | null;
  sceneId?: string | null;
  generationId?: string | null;
  exportId?: string | null;
  [key: string]: unknown;
}

/**
 * What a worker handler is given. Handlers report progress through these methods
 * so the durable job row (and therefore the UI) reflects real worker state.
 */
export interface JobContext {
  jobRowId: string;
  name: JobName;
  queueName: QueueName;
  /** 1-based attempt counter as reported by the queue. */
  attempt: number;
  attemptsAllowed: number;
  /** Records progress in the durable job row (0-100). */
  setProgress(progress: number): Promise<void>;
  logger: typeof logger;
}

/** Signature every job handler must implement. */
export type JobHandler<P extends JobEnvelope = JobEnvelope> = (
  payload: P,
  context: JobContext,
) => Promise<void>;

/**
 * Consumer side of the queue. Constructed only by the worker process so the API
 * never opens extra Redis connections it does not need.
 */
export interface QueueConsumer {
  register(name: JobName, handler: JobHandler): void;
  /** Attaches registered handlers to their queues and starts processing. */
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createQueue(options: {
  redisUrl: string;
  prefix: string;
  defaultMaxAttempts: number;
  defaultBackoffMs: number;
  jobs: JobRepository;
}): QueueService {
  const connection = new IORedis(options.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const queues = new Map<QueueName, Queue>();
  for (const name of Object.values(QUEUE_NAMES)) {
    queues.set(
      name,
      new Queue(name, {
        connection,
        prefix: options.prefix,
        defaultJobOptions: {
          attempts: options.defaultMaxAttempts,
          backoff: { type: 'exponential', delay: options.defaultBackoffMs },
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: false,
        },
      }),
    );
  }

  const events = new QueueEvents(QUEUE_NAMES.AI, { connection, prefix: options.prefix });
  events.on('failed', ({ jobId, failedReason }) => {
    logger.error({ jobId, failedReason }, 'job failed');
  });

  return {
    async enqueue(name, payload, enqueueOptions = {}) {
      const queueName = JOB_QUEUE_MAP[name];
      const queue = queues.get(queueName)!;

      // Durable mirror first: if the process dies between these two writes the
      // job row exists as 'queued' and can be replayed, which is preferable to a
      // Redis job with no trace in the database.
      const jobRow = await options.jobs.create({
        queue: queueName,
        name,
        payload,
        maxAttempts: enqueueOptions.maxAttempts ?? options.defaultMaxAttempts,
        organizationId: enqueueOptions.organizationId ?? null,
        projectId: enqueueOptions.projectId ?? null,
        generationId: enqueueOptions.generationId ?? null,
        exportId: enqueueOptions.exportId ?? null,
        dedupeKey: enqueueOptions.dedupeKey ?? null,
      });

      const jobOptions: JobsOptions = {
        jobId: jobRow.id,
        attempts: enqueueOptions.maxAttempts ?? options.defaultMaxAttempts,
        backoff: { type: 'exponential', delay: options.defaultBackoffMs },
      };
      if (enqueueOptions.delayMs) jobOptions.delay = enqueueOptions.delayMs;

      await queue.add(name, { ...payload, __jobRowId: jobRow.id }, jobOptions);
      await options.jobs.attachBullJobId(jobRow.id, jobRow.id);

      return { jobId: jobRow.id, queueName };
    },

    async cancel(jobId) {
      for (const queue of queues.values()) {
        const job = await queue.getJob(jobId);
        if (job) {
          await job.remove();
          return true;
        }
      }
      return false;
    },

    async setProgress(jobId, progress) {
      for (const queue of queues.values()) {
        const job = await queue.getJob(jobId);
        if (job) {
          await job.updateProgress(progress);
          break;
        }
      }
      await options.jobs.updateProgress(jobId, progress);
    },

    async health() {
      try {
        const pong = await connection.ping();
        return { ok: pong === 'PONG', queues: queues.size };
      } catch (error) {
        return {
          ok: false,
          queues: queues.size,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async close() {
      for (const queue of queues.values()) await queue.close();
      await events.close();
      connection.disconnect();
    },
  };
}

/**
 * Builds the worker-side consumer.
 *
 * Each registered handler is attached to the queue its job name maps to. Failed
 * jobs are recorded on the durable row with their attempt count; BullMQ handles
 * the exponential backoff and, once attempts are exhausted, stops retrying — the
 * row stays `failed` with its error, which is the operational dead-letter record.
 */
export function createQueueConsumer(options: {
  redisUrl: string;
  prefix: string;
  concurrency: number;
  jobs: JobRepository;
}): QueueConsumer {
  // A dedicated blocking connection: BullMQ requires maxRetriesPerRequest=null
  // for workers and a separate client from the enqueueing side.
  const connection = new IORedis(options.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

  const handlers = new Map<JobName, JobHandler>();
  const workers: Worker[] = [];

  return {
    register(name, handler) {
      handlers.set(name, handler as JobHandler);
    },

    async start() {
      // Group handlers by queue so each queue gets exactly one Worker (BullMQ
      // forbids two workers with the same name sharing a prefix).
      const byQueue = new Map<QueueName, JobName[]>();
      for (const name of handlers.keys()) {
        const queueName = JOB_QUEUE_MAP[name];
        const existing = byQueue.get(queueName) ?? [];
        existing.push(name);
        byQueue.set(queueName, existing);
      }

      for (const [queueName, names] of byQueue) {
        const worker = new Worker(
          queueName,
          async (job) => {
            const name = job.name as JobName;
            const payload = job.data as JobEnvelope;
            const jobRowId = payload.__jobRowId ?? String(job.id);
            const attempt = (job.attemptsMade ?? 0) + 1;
            const attemptsAllowed = job.opts.attempts ?? 1;

            const handler = handlers.get(name);
            if (!handler) {
              // A declared job name with no handler on this worker build. Without this
              // bookkeeping the durable row would stay `queued` forever, so it would be
              // indistinguishable from work that has not been picked up yet and would be
              // replayed indefinitely by an operator loop. Recording the attempt and then
              // the outcome makes the job dead-letter like any other failure.
              await options.jobs.markAttempted(jobRowId);
              const message = `No handler registered for job "${name}".`;
              if (attempt >= attemptsAllowed) {
                await options.jobs.markFailed(jobRowId, message);
              } else {
                await options.jobs.markRetrying(jobRowId, message);
              }
              logger.error(
                { jobId: job.id, name, queueName, attempt, attemptsAllowed },
                'no handler registered for job name',
              );
              throw new Error(message);
            }

            await options.jobs.markStarted(jobRowId);

            const context: JobContext = {
              jobRowId,
              name,
              queueName,
              attempt,
              attemptsAllowed,
              setProgress: async (progress: number) => {
                await job.updateProgress(progress);
                await options.jobs.updateProgress(jobRowId, Math.max(0, Math.min(100, Math.round(progress))));
              },
              logger: logger.child({ jobRowId, name, queueName, attempt }),
            };

            try {
              await handler(payload, context);
              await options.jobs.markCompleted(jobRowId);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const exhausted = attempt >= attemptsAllowed;
              if (exhausted) {
                await options.jobs.markFailed(jobRowId, message);
              } else {
                await options.jobs.markRetrying(jobRowId, message);
              }
              // Re-throw so BullMQ applies the backoff and, when attempts are
              // exhausted, moves the job to its failed set.
              throw error;
            }
          },
          {
            connection,
            prefix: options.prefix,
            concurrency: options.concurrency,
          },
        );

        worker.on('failed', (job, error) => {
          logger.error(
            { jobId: job?.id, name: job?.name, attemptsMade: job?.attemptsMade, err: error },
            'job attempt failed',
          );
        });
        worker.on('error', (error) => {
          logger.error({ err: error }, 'queue worker error');
        });

        workers.push(worker);
        logger.info({ queueName, jobNames: names, concurrency: options.concurrency }, 'queue consumer attached');
      }
    },

    async close() {
      for (const worker of workers) await worker.close();
      connection.disconnect();
    },
  };
}
