/** Generation requests, attempts and provider traffic. */
import type { PoolClient } from 'pg';

import { query, queryOne } from '../db/pool';
import { toGenerationDTO, type Row } from '../db/mappers';
import type { AICapability, GenerationDTO, GenerationKind, GenerationStatus } from '@zyvano/shared';

export interface GenerationListFilters {
  organizationId: string;
  projectId?: string | undefined;
  status?: GenerationStatus | undefined;
  kind?: GenerationKind | undefined;
  page: number;
  perPage: number;
}

export class GenerationRepository {
  async create(input: {
    organizationId: string;
    projectId: string;
    sceneId?: string | null;
    requestedBy: string;
    kind: GenerationKind;
    capability: AICapability;
    provider?: string | null;
    model?: string | null;
    prompt?: string | null;
    parameters?: Record<string, unknown>;
    idempotencyKey?: string | null;
    creditsReserved?: number;
  }): Promise<Row> {
    const row = await queryOne<Row>(
      `INSERT INTO generations
         (organization_id, project_id, scene_id, requested_by, kind, capability, provider, model,
          prompt, parameters, idempotency_key, credits_reserved)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        input.organizationId,
        input.projectId,
        input.sceneId ?? null,
        input.requestedBy,
        input.kind,
        input.capability,
        input.provider ?? null,
        input.model ?? null,
        input.prompt ?? null,
        JSON.stringify(input.parameters ?? {}),
        input.idempotencyKey ?? null,
        input.creditsReserved ?? 0,
      ],
    );
    return row!;
  }

  async findById(id: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM generations WHERE id = $1', [id]);
  }

  async findByIdInOrganization(id: string, organizationId: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM generations WHERE id = $1 AND organization_id = $2', [
      id,
      organizationId,
    ]);
  }

  /** Idempotency lookup: returns the earlier generation for a repeated key. */
  async findByIdempotencyKey(organizationId: string, key: string): Promise<Row | null> {
    return queryOne<Row>(
      'SELECT * FROM generations WHERE organization_id = $1 AND idempotency_key = $2',
      [organizationId, key],
    );
  }

  async list(filters: GenerationListFilters): Promise<{ items: GenerationDTO[]; total: number }> {
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
    if (filters.kind) {
      params.push(filters.kind);
      conditions.push(`kind = $${params.length}`);
    }

    const where = conditions.join(' AND ');
    const offset = (filters.page - 1) * filters.perPage;

    const [rows, countRow] = await Promise.all([
      query<Row>(
        `SELECT * FROM generations WHERE ${where}
          ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.perPage, offset],
      ),
      queryOne<{ count: string }>(`SELECT COUNT(*)::text AS count FROM generations WHERE ${where}`, params),
    ]);

    return { items: rows.rows.map((row) => toGenerationDTO(row)), total: Number(countRow?.count ?? 0) };
  }

  async getWithAttempts(id: string): Promise<{ generation: Row; attempts: Row[] } | null> {
    const generation = await queryOne<Row>('SELECT * FROM generations WHERE id = $1', [id]);
    if (!generation) return null;
    const attempts = await query<Row>(
      'SELECT * FROM generation_attempts WHERE generation_id = $1 ORDER BY attempt_number ASC',
      [id],
    );
    return { generation, attempts: attempts.rows };
  }

  /**
   * Atomically claims a queued generation for processing. Returns null when the
   * row was already claimed, which is what makes the worker idempotent under
   * duplicate job delivery.
   */
  async claim(id: string): Promise<Row | null> {
    return queryOne<Row>(
      `UPDATE generations
          SET status = 'processing', started_at = COALESCE(started_at, now()), progress = GREATEST(progress, 5)
        WHERE id = $1 AND status = 'queued'
        RETURNING *`,
      [id],
    );
  }

  async updateProgress(id: string, progress: number): Promise<void> {
    await query('UPDATE generations SET progress = $2 WHERE id = $1 AND status = \'processing\'', [
      id,
      Math.max(0, Math.min(100, Math.round(progress))),
    ]);
  }

  async markCompleted(input: {
    id: string;
    result: Record<string, unknown> | null;
    outputAssetId?: string | null;
    creditsUsed: number;
  }): Promise<void> {
    // The `status <> 'cancelled'` guard is what makes the documented contract true:
    // a generation cancelled while a worker was mid-flight must not be resurrected
    // by that worker's late result.
    await query(
      `UPDATE generations
          SET status = 'completed', progress = 100, result = $2,
              output_asset_id = COALESCE($3, output_asset_id),
              credits_used = $4, error_code = NULL, error_message = NULL,
              finished_at = now()
        WHERE id = $1 AND status <> 'cancelled'`,
      [
        input.id,
        input.result ? JSON.stringify(input.result) : null,
        input.outputAssetId ?? null,
        input.creditsUsed,
      ],
    );
  }

  async markFailed(input: { id: string; errorCode: string; errorMessage: string }): Promise<void> {
    await query(
      `UPDATE generations
          SET status = 'failed', error_code = $2, error_message = $3, finished_at = now()
        WHERE id = $1 AND status <> 'cancelled'`,
      [input.id, input.errorCode, input.errorMessage.slice(0, 2000)],
    );
  }

  async markQueuedForRetry(id: string): Promise<void> {
    await query(
      "UPDATE generations SET status = 'queued', progress = 0 WHERE id = $1 AND status NOT IN ('completed','cancelled')",
      [id],
    );
  }

  async cancel(id: string): Promise<boolean> {
    const result = await query(
      `UPDATE generations
          SET status = 'cancelled', cancelled_at = now(), finished_at = now()
        WHERE id = $1 AND status IN ('queued','processing')`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async setProvider(id: string, provider: string, model: string | null): Promise<void> {
    await query('UPDATE generations SET provider = $2, model = $3 WHERE id = $1', [id, provider, model]);
  }

  /** Generations stuck in `processing` past the threshold (crashed workers). */
  async findStaleProcessing(olderThanMinutes: number, limit = 50): Promise<Row[]> {
    const rows = await query<Row>(
      `SELECT * FROM generations
        WHERE status = 'processing'
          AND COALESCE(started_at, created_at) < now() - ($1 || ' minutes')::interval
        ORDER BY created_at ASC LIMIT $2`,
      [String(olderThanMinutes), limit],
    );
    return rows.rows;
  }

  /* -------------------------------- attempts -------------------------------- */

  async startAttempt(input: {
    generationId: string;
    provider: string;
    model: string | null;
    requestPayload: Record<string, unknown>;
  }): Promise<Row> {
    const row = await queryOne<Row>(
      `INSERT INTO generation_attempts (generation_id, attempt_number, provider, model, status, request_payload, started_at)
       VALUES (
         $1,
         (SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM generation_attempts WHERE generation_id = $1),
         $2, $3, 'processing', $4, now()
       )
       RETURNING *`,
      [input.generationId, input.provider, input.model, JSON.stringify(input.requestPayload)],
    );
    return row!;
  }

  async completeAttempt(input: {
    id: string;
    latencyMs: number;
    externalRequestId: string | null;
    responseSummary: Record<string, unknown>;
  }): Promise<void> {
    await query(
      `UPDATE generation_attempts
          SET status = 'completed', latency_ms = $2, external_request_id = $3,
              response_summary = $4, finished_at = now()
        WHERE id = $1`,
      [
        input.id,
        input.latencyMs,
        input.externalRequestId,
        JSON.stringify(input.responseSummary),
      ],
    );
  }

  async failAttempt(input: {
    id: string;
    latencyMs: number;
    errorCode: string;
    errorMessage: string;
    externalRequestId?: string | null;
  }): Promise<void> {
    await query(
      `UPDATE generation_attempts
          SET status = 'failed', latency_ms = $2, error_code = $3, error_message = $4,
              external_request_id = COALESCE($5, external_request_id), finished_at = now()
        WHERE id = $1`,
      [input.id, input.latencyMs, input.errorCode, input.errorMessage.slice(0, 2000), input.externalRequestId ?? null],
    );
  }

  async listAttempts(generationId: string): Promise<Row[]> {
    const rows = await query<Row>(
      'SELECT * FROM generation_attempts WHERE generation_id = $1 ORDER BY attempt_number ASC',
      [generationId],
    );
    return rows.rows;
  }

  /* ---------------------------- provider requests ---------------------------- */

  async recordProviderRequest(input: {
    generationId: string | null;
    attemptId: string | null;
    organizationId: string | null;
    provider: string;
    capability: string;
    model: string | null;
    externalRequestId: string | null;
    status: string;
    httpStatus?: number | null;
    latencyMs: number;
    inputUnits?: number | null;
    outputUnits?: number | null;
    credits: number;
    errorCode?: string | null;
  }): Promise<void> {
    await query(
      `INSERT INTO provider_requests
         (generation_id, attempt_id, organization_id, provider, capability, model, external_request_id,
          status, http_status, latency_ms, input_units, output_units, credits, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        input.generationId,
        input.attemptId,
        input.organizationId,
        input.provider,
        input.capability,
        input.model,
        input.externalRequestId,
        input.status,
        input.httpStatus ?? null,
        input.latencyMs,
        input.inputUnits ?? null,
        input.outputUnits ?? null,
        input.credits,
        input.errorCode ?? null,
      ],
    );
  }

  async deleteForProject(projectId: string, client?: PoolClient): Promise<void> {
    if (client) {
      await client.query('DELETE FROM generations WHERE project_id = $1', [projectId]);
      return;
    }
    await query('DELETE FROM generations WHERE project_id = $1', [projectId]);
  }
}
