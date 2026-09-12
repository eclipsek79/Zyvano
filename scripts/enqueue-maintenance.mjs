/**
 * Enqueues a maintenance job and reports the durable job row it created.
 *
 * This is an operator tool: it exercises the real queue path (durable `jobs` row
 * plus a BullMQ job) without needing an AI provider to be configured, which makes
 * it the smoke test for worker deployment.
 *
 * Usage: node scripts/enqueue-maintenance.mjs
 */
import { buildContainer } from '../packages/server/src/container.ts';

const container = buildContainer();

const { jobId, queueName } = await container.queue.enqueue(
  'CleanupExpiredFiles',
  { triggeredBy: 'scripts/enqueue-maintenance.mjs' },
  { maxAttempts: 2 },
);

console.log(`enqueued ${jobId} on ${queueName}`);

// Poll the durable row so the caller can observe the worker advancing it.
for (let attempt = 0; attempt < 30; attempt += 1) {
  const row = await container.repositories.jobs.findById(jobId);
  console.log(`status=${row?.status} progress=${row?.progress} attempts=${row?.attempts_made ?? 0}`);
  if (row && ['completed', 'failed', 'cancelled'].includes(row.status)) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

await container.close();
process.exit(0);
