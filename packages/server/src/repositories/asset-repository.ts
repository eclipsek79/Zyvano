/** Media asset metadata. Bytes live in object storage, keyed by storage_key. */
import type { PoolClient } from 'pg';

import { query, queryOne } from '../db/pool';
import { toAssetDTO, type Row } from '../db/mappers';
import type { AssetDTO, AssetKind, AssetSource } from '@zyvano/shared';

export interface AssetListFilters {
  organizationId: string;
  projectId?: string | undefined;
  kind?: AssetKind | undefined;
  source?: AssetSource | undefined;
  search?: string | undefined;
  page: number;
  perPage: number;
}

export class AssetRepository {
  async create(input: {
    organizationId: string;
    projectId?: string | null;
    ownerId: string;
    kind: AssetKind;
    source: AssetSource;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    thumbnailKey?: string | null;
    width?: number | null;
    height?: number | null;
    durationSeconds?: number | null;
    checksum?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<Row> {
    const row = await queryOne<Row>(
      `INSERT INTO assets
         (organization_id, project_id, owner_id, kind, source, filename, mime_type, size_bytes,
          storage_key, thumbnail_key, width, height, duration_seconds, checksum, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING *`,
      [
        input.organizationId,
        input.projectId ?? null,
        input.ownerId,
        input.kind,
        input.source,
        input.filename,
        input.mimeType,
        input.sizeBytes,
        input.storageKey,
        input.thumbnailKey ?? null,
        input.width ?? null,
        input.height ?? null,
        input.durationSeconds ?? null,
        input.checksum ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return row!;
  }

  async findById(id: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM assets WHERE id = $1 AND deleted_at IS NULL', [id]);
  }

  /**
   * Authorization-relevant read: returns the asset only when it belongs to the
   * given organization. Prevents cross-tenant access even if an id leaks.
   */
  async findByIdInOrganization(id: string, organizationId: string): Promise<Row | null> {
    return queryOne<Row>(
      'SELECT * FROM assets WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, organizationId],
    );
  }

  async list(filters: AssetListFilters): Promise<{ items: AssetDTO[]; total: number }> {
    const conditions = ['a.organization_id = $1', 'a.deleted_at IS NULL'];
    const params: unknown[] = [filters.organizationId];

    if (filters.projectId) {
      params.push(filters.projectId);
      conditions.push(`a.project_id = $${params.length}`);
    }
    if (filters.kind) {
      params.push(filters.kind);
      conditions.push(`a.kind = $${params.length}`);
    }
    if (filters.source) {
      params.push(filters.source);
      conditions.push(`a.source = $${params.length}`);
    }
    if (filters.search) {
      params.push(`%${filters.search}%`);
      conditions.push(`a.filename ILIKE $${params.length}`);
    }

    const where = conditions.join(' AND ');
    const offset = (filters.page - 1) * filters.perPage;

    const [rows, countRow] = await Promise.all([
      query<Row>(
        `SELECT a.* FROM assets a WHERE ${where}
          ORDER BY a.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.perPage, offset],
      ),
      queryOne<{ count: string }>(`SELECT COUNT(*)::text AS count FROM assets a WHERE ${where}`, params),
    ]);

    return { items: rows.rows.map((row) => toAssetDTO(row)), total: Number(countRow?.count ?? 0) };
  }

  async updateProcessing(
    id: string,
    fields: {
      width?: number | null;
      height?: number | null;
      durationSeconds?: number | null;
      thumbnailKey?: string | null;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const columns: Record<string, unknown> = {};
    if (fields.width !== undefined) columns.width = fields.width;
    if (fields.height !== undefined) columns.height = fields.height;
    if (fields.durationSeconds !== undefined) columns.duration_seconds = fields.durationSeconds;
    if (fields.thumbnailKey !== undefined) columns.thumbnail_key = fields.thumbnailKey;
    if (fields.metadata !== undefined) columns.metadata = JSON.stringify(fields.metadata);
    if (Object.keys(columns).length === 0) return;

    const entries = Object.entries(columns);
    const values = entries.map(([, value]) => value);
    const sets = entries.map(([column], index) => `${column} = $${index + 1}`);
    values.push(id);
    await query(
      `UPDATE assets SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
      values,
    );
  }

  /** Soft delete: keeps the row so audit/history stay intact. */
  async softDelete(id: string): Promise<void> {
    await query('UPDATE assets SET deleted_at = now(), updated_at = now() WHERE id = $1', [id]);
  }

  /** Records storage keys to be physically removed by the cleanup worker. */
  async recordDeletion(input: {
    assetId: string;
    storageKeys: string[];
    requestedBy?: string | null;
  }): Promise<void> {
    await query(
      `INSERT INTO asset_deletions (asset_id, storage_keys, requested_by) VALUES ($1, $2, $3)`,
      [input.assetId, input.storageKeys, input.requestedBy ?? null],
    );
  }

  async listPendingDeletions(limit = 100): Promise<Row[]> {
    const rows = await query<Row>(
      `SELECT * FROM asset_deletions WHERE completed_at IS NULL
        ORDER BY created_at ASC LIMIT $1`,
      [limit],
    );
    return rows.rows;
  }

  async completeDeletion(id: string): Promise<void> {
    await query('UPDATE asset_deletions SET completed_at = now() WHERE id = $1', [id]);
  }

  async recordDeletionFailure(id: string, error: string): Promise<void> {
    await query(
      'UPDATE asset_deletions SET attempts = attempts + 1, last_error = $2 WHERE id = $1',
      [id, error.slice(0, 1000)],
    );
  }

  /**
   * Deletes every asset of an organization and reports how many storage objects
   * were referenced. The repository never touches object storage; the caller
   * owns the purge.
   */
  async hardDeleteAllForOrganization(
    organizationId: string,
  ): Promise<{ deleted: number; failed: string[] }> {
    const rows = await query<{ storage_key: string; thumbnail_key: string | null }>(
      'SELECT storage_key, thumbnail_key FROM assets WHERE organization_id = $1',
      [organizationId],
    );

    let keyCount = 0;
    for (const row of rows.rows) {
      keyCount += 1;
      if (row.thumbnail_key) keyCount += 1;
    }

    await query('DELETE FROM assets WHERE organization_id = $1', [organizationId]);
    return { deleted: keyCount, failed: [] };
  }

  /** Hard-deletes an asset row (used by account/project deletion after storage purge). */
  async hardDelete(id: string, client?: PoolClient): Promise<void> {
    if (client) {
      await client.query('DELETE FROM assets WHERE id = $1', [id]);
      return;
    }
    await query('DELETE FROM assets WHERE id = $1', [id]);
  }

  /**
   * Every storage key an organization owns, including thumbnail derivatives.
   *
   * Read before any rows are removed: once the asset rows are gone nothing in the
   * database remembers what needs purging from object storage.
   */
  async listStorageKeysForOrganization(organizationId: string): Promise<string[]> {
    const rows = await query<{ storage_key: string; thumbnail_key: string | null }>(
      'SELECT storage_key, thumbnail_key FROM assets WHERE organization_id = $1',
      [organizationId],
    );
    const keys: string[] = [];
    for (const row of rows.rows) {
      keys.push(row.storage_key);
      if (row.thumbnail_key) keys.push(row.thumbnail_key);
    }
    return keys;
  }

  /** Assets one user uploaded or that were generated on their behalf. */
  async countByOwnerInOrganization(organizationId: string, ownerId: string): Promise<number> {
    const row = await queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM assets WHERE organization_id = $1 AND owner_id = $2',
      [organizationId, ownerId],
    );
    return Number(row?.count ?? 0);
  }

  /** Total stored bytes an organization references. Used for deletion accounting. */
  async sumSizeBytesForOrganization(organizationId: string): Promise<number> {
    const row = await queryOne<{ total: string | null }>(
      'SELECT COALESCE(SUM(size_bytes), 0)::text AS total FROM assets WHERE organization_id = $1',
      [organizationId],
    );
    return Number(row?.total ?? 0);
  }

  /** Total stored bytes attributable to one user's assets inside an organization. */
  async sumSizeBytesForOwner(organizationId: string, ownerId: string): Promise<number> {
    const row = await queryOne<{ total: string | null }>(
      'SELECT COALESCE(SUM(size_bytes), 0)::text AS total FROM assets WHERE organization_id = $1 AND owner_id = $2',
      [organizationId, ownerId],
    );
    return Number(row?.total ?? 0);
  }

  async countByProject(projectId: string): Promise<number> {
    const row = await queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM assets WHERE project_id = $1 AND deleted_at IS NULL',
      [projectId],
    );
    return Number(row?.count ?? 0);
  }
}
