/** Exports (renders) and their produced files. */
import type { PoolClient } from 'pg';

import { query, queryOne } from '../db/pool';
import { toExportDTO, toExportFileDTO, type Row } from '../db/mappers';
import type { ExportDTO, ExportStatus } from '@zyvano/shared';

export interface ExportListFilters {
  organizationId: string;
  projectId?: string | undefined;
  status?: ExportStatus | undefined;
  page: number;
  perPage: number;
}

export class ExportRepository {
  async create(input: {
    organizationId: string;
    projectId: string;
    requestedBy: string;
    preset: string;
    format: string;
    resolution: string;
    includeAudio: boolean;
    idempotencyKey?: string | null;
    expiresAt?: Date | null;
  }): Promise<Row> {
    const row = await queryOne<Row>(
      `INSERT INTO exports
         (organization_id, project_id, requested_by, preset, format, resolution, include_audio, idempotency_key, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        input.organizationId,
        input.projectId,
        input.requestedBy,
        input.preset,
        input.format,
        input.resolution,
        input.includeAudio,
        input.idempotencyKey ?? null,
        input.expiresAt ?? null,
      ],
    );
    return row!;
  }

  async findById(id: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM exports WHERE id = $1', [id]);
  }

  async findByIdInOrganization(id: string, organizationId: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM exports WHERE id = $1 AND organization_id = $2', [
      id,
      organizationId,
    ]);
  }

  async findByIdempotencyKey(organizationId: string, key: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM exports WHERE organization_id = $1 AND idempotency_key = $2', [
      organizationId,
      key,
    ]);
  }

  async list(filters: ExportListFilters): Promise<{ items: ExportDTO[]; total: number }> {
    const conditions = ['organization_id = $1'];
    const params: unknown[] = [filters.organizationId];
    if (filters.projectId) {
      params.push(filters.projectId);
      conditions.push(`project_id = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }
    const where = conditions.join(' AND ');
    const offset = (filters.page - 1) * filters.perPage;

    const [rows, countRow] = await Promise.all([
      query<Row>(
        `SELECT * FROM exports WHERE ${where} ORDER BY created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.perPage, offset],
      ),
      queryOne<{ count: string }>(`SELECT COUNT(*)::text AS count FROM exports WHERE ${where}`, params),
    ]);
    return { items: rows.rows.map((row) => toExportDTO(row)), total: Number(countRow?.count ?? 0) };
  }

  /** Atomically claims a queued export (idempotent under duplicate job delivery). */
  async claim(id: string): Promise<Row | null> {
    return queryOne<Row>(
      `UPDATE exports SET status = 'processing', started_at = COALESCE(started_at, now()), progress = GREATEST(progress, 5)
        WHERE id = $1 AND status = 'queued' RETURNING *`,
      [id],
    );
  }

  async updateProgress(id: string, progress: number): Promise<void> {
    await query("UPDATE exports SET progress = $2 WHERE id = $1 AND status = 'processing'", [
      id,
      Math.max(0, Math.min(100, Math.round(progress))),
    ]);
  }

  /**
   * Marks the export complete. `verified` must only be true after the render
   * worker has confirmed every output object exists in storage — the API refuses
   * to serve a download otherwise.
   */
  async markCompleted(input: { id: string; verified: boolean }): Promise<void> {
    await query(
      `UPDATE exports SET status = 'completed', progress = 100, verified = $2,
              error_code = NULL, error_message = NULL, finished_at = now()
        WHERE id = $1`,
      [input.id, input.verified],
    );
  }

  async markFailed(input: { id: string; errorCode: string; errorMessage: string }): Promise<void> {
    await query(
      `UPDATE exports SET status = 'failed', error_code = $2, error_message = $3, finished_at = now()
        WHERE id = $1 AND status <> 'cancelled'`,
      [input.id, input.errorCode, input.errorMessage.slice(0, 2000)],
    );
  }

  async cancel(id: string): Promise<boolean> {
    const result = await query(
      `UPDATE exports SET status = 'cancelled', cancelled_at = now(), finished_at = now()
        WHERE id = $1 AND status IN ('queued','processing')`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async addFile(input: { exportId: string; assetId: string; kind: string }): Promise<void> {
    await query(
      'INSERT INTO export_files (export_id, asset_id, kind) VALUES ($1, $2, $3)',
      [input.exportId, input.assetId, input.kind],
    );
  }

  /** Files joined with their asset metadata; `url` is filled in by the service. */
  async listFiles(exportId: string): Promise<Row[]> {
    const rows = await query<Row>(
      `SELECT ef.id, ef.asset_id, ef.kind, ef.created_at,
              a.filename, a.mime_type, a.size_bytes, a.duration_seconds, a.storage_key
         FROM export_files ef
         JOIN assets a ON a.id = ef.asset_id
        WHERE ef.export_id = $1 AND a.deleted_at IS NULL
        ORDER BY ef.created_at ASC`,
      [exportId],
    );
    return rows.rows;
  }

  async getWithFiles(id: string): Promise<{ dto: ExportDTO; files: Row[] } | null> {
    const row = await this.findById(id);
    if (!row) return null;
    const files = await this.listFiles(id);
    return { dto: toExportDTO(row), files };
  }

  /** Completed exports past their retention window, for the cleanup worker. */
  async findExpired(limit = 50): Promise<Row[]> {
    const rows = await query<Row>(
      `SELECT * FROM exports
        WHERE status = 'completed' AND expires_at IS NOT NULL AND expires_at < now()
        ORDER BY expires_at ASC LIMIT $1`,
      [limit],
    );
    return rows.rows;
  }

  async deleteCascade(id: string, client?: PoolClient): Promise<void> {
    if (client) {
      await client.query('DELETE FROM exports WHERE id = $1', [id]);
      return;
    }
    await query('DELETE FROM exports WHERE id = $1', [id]);
  }

  async deleteForProject(projectId: string, client?: PoolClient): Promise<void> {
    if (client) {
      await client.query('DELETE FROM exports WHERE project_id = $1', [projectId]);
      return;
    }
    await query('DELETE FROM exports WHERE project_id = $1', [projectId]);
  }
}

export { toExportFileDTO };
