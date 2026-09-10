/** Durable mirror of queued jobs. */
import type { PoolClient } from 'pg';

import { query, queryOne } from '../db/pool';
import { toJobDTO, type Row } from '../db/mappers';
import type { JobDTO } from '@zyvano/shared';

export class JobRepository {
  async create(input: {
    queue: string;
    name: string;
    payload: Record<string, unknown>;
    maxAttempts: number;
    organizationId?: string | null;
    projectId?: string | null;
    generationId?: string | null;
    exportId?: string | null;
    dedupeKey?: string | null;
  }): Promise<Row> {
    const row = await queryOne<Row>(
      `INSERT INTO jobs
         (queue, name, payload, max_attempts, organization_id, project_id, generation_id, export_id, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        input.queue,
        input.name,
        JSON.stringify(input.payload),
        input.maxAttempts,
        input.organizationId ?? null,
        input.projectId ?? null,
        input.generationId ?? null,
        input.exportId ?? null,
        input.dedupeKey ?? null,
      ],
    );
    return row!;
  }

  async attachBullJobId(id: string, bullJobId: string): Promise<void> {
    await query('UPDATE jobs SET bull_job_id = $2 WHERE id = $1', [id, bullJobId]);
  }

  /**
   * Records that a delivery was attempted, without claiming the job started.
   *
   * Used for deliveries that never reach a handler (an unimplemented job name), so the
   * attempt counter still reflects reality. `markStarted` cannot be used there because it
   * also moves the row to `processing`, which would misreport a job that never began.
   */
  async markAttempted(id: string): Promise<void> {
    await query('UPDATE jobs SET attempts_made = attempts_made + 1 WHERE id = $1', [id]);
  }

  async markStarted(id: string): Promise<void> {
    await query(
      "UPDATE jobs SET status = 'processing', started_at = COALESCE(started_at, now()), attempts_made = attempts_made + 1 WHERE id = $1",
      [id],
    );
  }

  async updateProgress(id: string, progress: number): Promise<void> {
    await query('UPDATE jobs SET progress = $2 WHERE id = $1', [
      id,
      Math.max(0, Math.min(100, Math.round(progress))),
    ]);
  }

  async markCompleted(id: string): Promise<void> {
    await query(
      "UPDATE jobs SET status = 'completed', progress = 100, finished_at = now(), last_error = NULL WHERE id = $1",
      [id],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await query("UPDATE jobs SET status = 'failed', last_error = $2, finished_at = now() WHERE id = $1", [
      id,
      error.slice(0, 2000),
    ]);
  }

  /**
   * Records a retryable failure without terminating the job: the BullMQ worker
   * will attempt it again, so the row stays `processing`.
   */
  async markRetrying(id: string, error: string): Promise<void> {
    await query('UPDATE jobs SET last_error = $2 WHERE id = $1', [id, error.slice(0, 2000)]);
  }

  async markCancelled(id: string): Promise<void> {
    await query("UPDATE jobs SET status = 'cancelled', finished_at = now() WHERE id = $1", [id]);
  }

  async findById(id: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM jobs WHERE id = $1', [id]);
  }

  async findByGeneration(generationId: string): Promise<JobDTO[]> {
    const rows = await query<Row>(
      'SELECT * FROM jobs WHERE generation_id = $1 ORDER BY created_at DESC',
      [generationId],
    );
    return rows.rows.map(toJobDTO);
  }

  async findByProject(projectId: string, limit = 50): Promise<JobDTO[]> {
    const rows = await query<Row>(
      'SELECT * FROM jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2',
      [projectId, limit],
    );
    return rows.rows.map(toJobDTO);
  }

  async findByExport(exportId: string): Promise<JobDTO[]> {
    const rows = await query<Row>('SELECT * FROM jobs WHERE export_id = $1 ORDER BY created_at DESC', [
      exportId,
    ]);
    return rows.rows.map(toJobDTO);
  }

  async listPending(limit = 100): Promise<Row[]> {
    const rows = await query<Row>(
      "SELECT * FROM jobs WHERE status IN ('queued','processing') ORDER BY created_at ASC LIMIT $1",
      [limit],
    );
    return rows.rows;
  }

  /** Jobs whose process died: still `processing` well past any plausible runtime. */
  async findStale(olderThanMinutes: number, limit = 50): Promise<Row[]> {
    const rows = await query<Row>(
      `SELECT * FROM jobs
        WHERE status = 'processing'
          AND COALESCE(started_at, created_at) < now() - ($1 || ' minutes')::interval
        ORDER BY created_at ASC LIMIT $2`,
      [String(olderThanMinutes), limit],
    );
    return rows.rows;
  }

  async deleteForProject(projectId: string, client?: PoolClient): Promise<void> {
    if (client) {
      await client.query('DELETE FROM jobs WHERE project_id = $1', [projectId]);
      return;
    }
    await query('DELETE FROM jobs WHERE project_id = $1', [projectId]);
  }

  async deleteOlderThan(days: number): Promise<number> {
    const result = await query(
      `DELETE FROM jobs WHERE finished_at IS NOT NULL AND finished_at < now() - ($1 || ' days')::interval`,
      [String(days)],
    );
    return result.rowCount ?? 0;
  }
}
