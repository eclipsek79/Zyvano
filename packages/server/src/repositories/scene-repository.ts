/** Scenes (the executable representation of a storyboard). */
import { query, queryOne } from '../db/pool';
import { toSceneDTO, type Row } from '../db/mappers';
import type { SceneDTO } from '@zyvano/shared';
import type { PoolClient } from 'pg';

export class SceneRepository {
  async create(input: {
    projectId: string;
    title: string;
    description?: string | null;
    prompt?: string | null;
    durationSeconds?: number;
    orderIndex?: number;
  }): Promise<Row> {
    const row = await queryOne<Row>(
      `INSERT INTO scenes (project_id, title, description, prompt, duration_seconds, order_index)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, (SELECT COALESCE(MAX(order_index) + 1, 0) FROM scenes WHERE project_id = $1)))
       RETURNING *`,
      [
        input.projectId,
        input.title,
        input.description ?? null,
        input.prompt ?? null,
        input.durationSeconds ?? 5,
        input.orderIndex ?? null,
      ],
    );
    return row!;
  }

  async findById(id: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM scenes WHERE id = $1', [id]);
  }

  /** Batched insert used when a generated storyboard becomes scenes. */
  async createMany(
    client: PoolClient,
    projectId: string,
    scenes: Array<{ title: string; description?: string | null; prompt?: string | null; durationSeconds?: number }>,
    startIndex = 0,
  ): Promise<Row[]> {
    const created: Row[] = [];
    let index = startIndex;
    for (const scene of scenes) {
      const result = await client.query<Row>(
        `INSERT INTO scenes (project_id, title, description, prompt, duration_seconds, order_index)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [
          projectId,
          scene.title,
          scene.description ?? null,
          scene.prompt ?? null,
          scene.durationSeconds ?? 5,
          index,
        ],
      );
      created.push(result.rows[0]!);
      index += 1;
    }
    return created;
  }

  /** Deletes existing scenes for a project (used when regenerating a storyboard). */
  async deleteForProject(client: PoolClient, projectId: string): Promise<void> {
    await client.query('DELETE FROM scenes WHERE project_id = $1', [projectId]);
  }

  async listByProject(projectId: string): Promise<SceneDTO[]> {
    const rows = await query<Row>(
      'SELECT * FROM scenes WHERE project_id = $1 ORDER BY order_index ASC',
      [projectId],
    );
    return rows.rows.map(toSceneDTO);
  }

  async update(
    id: string,
    fields: {
      title?: string;
      description?: string | null;
      prompt?: string | null;
      durationSeconds?: number;
      orderIndex?: number;
    },
  ): Promise<Row | null> {
    const columns: Record<string, unknown> = {};
    if (fields.title !== undefined) columns.title = fields.title;
    if (fields.description !== undefined) columns.description = fields.description;
    if (fields.prompt !== undefined) columns.prompt = fields.prompt;
    if (fields.durationSeconds !== undefined) columns.duration_seconds = fields.durationSeconds;
    if (fields.orderIndex !== undefined) columns.order_index = fields.orderIndex;
    if (Object.keys(columns).length === 0) return this.findById(id);

    const entries = Object.entries(columns);
    const values = entries.map(([, value]) => value);
    const sets = entries.map(([column], index) => `${column} = $${index + 1}`);
    values.push(id);
    return queryOne<Row>(
      `UPDATE scenes SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values,
    );
  }

  async updateStatus(
    id: string,
    status: string,
    extra: { previewAssetId?: string | null } = {},
  ): Promise<void> {
    await query(
      `UPDATE scenes
          SET status = $2,
              preview_asset_id = COALESCE($3, preview_asset_id),
              updated_at = now()
        WHERE id = $1`,
      [id, status, extra.previewAssetId ?? null],
    );
  }

  /** Persists a new explicit ordering; executed inside a transaction. */
  async reorder(client: PoolClient, projectId: string, sceneIds: string[]): Promise<void> {
    for (const [index, sceneId] of sceneIds.entries()) {
      await client.query(
        'UPDATE scenes SET order_index = $3, updated_at = now() WHERE id = $1 AND project_id = $2',
        [sceneId, projectId, index],
      );
    }
  }

  async delete(id: string): Promise<boolean> {
    const result = await query('DELETE FROM scenes WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async countByProject(projectId: string): Promise<number> {
    const row = await queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM scenes WHERE project_id = $1',
      [projectId],
    );
    return Number(row?.count ?? 0);
  }
}
