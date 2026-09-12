/** Scripts and storyboards. */
import { query, queryOne } from '../db/pool';
import { toScriptDTO, toStoryboardDTO, type Row } from '../db/mappers';
import type { ScriptDTO, StoryboardDTO, StoryboardShot } from '@zyvano/shared';

export class ScriptRepository {
  /**
   * Inserts a new script version. The version number is derived atomically inside
   * the statement so concurrent writes cannot collide on the unique constraint.
   */
  async create(input: {
    projectId: string;
    title: string;
    content: string;
    tone?: string | null;
    language?: string;
    sourceGenerationId?: string | null;
    createdBy?: string | null;
  }): Promise<Row> {
    const row = await queryOne<Row>(
      `INSERT INTO scripts
         (project_id, title, content, tone, language, version, source_generation_id, created_by)
       VALUES (
         $1, $2, $3, $4, $5,
         (SELECT COALESCE(MAX(version), 0) + 1 FROM scripts WHERE project_id = $1),
         $6, $7
       )
       RETURNING *`,
      [
        input.projectId,
        input.title,
        input.content,
        input.tone ?? null,
        input.language ?? 'en',
        input.sourceGenerationId ?? null,
        input.createdBy ?? null,
      ],
    );
    return row!;
  }

  async findById(id: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM scripts WHERE id = $1', [id]);
  }

  async latestForProject(projectId: string): Promise<ScriptDTO | null> {
    const row = await queryOne<Row>(
      'SELECT * FROM scripts WHERE project_id = $1 ORDER BY version DESC LIMIT 1',
      [projectId],
    );
    return row ? toScriptDTO(row) : null;
  }

  async listForProject(projectId: string): Promise<ScriptDTO[]> {
    const rows = await query<Row>(
      'SELECT * FROM scripts WHERE project_id = $1 ORDER BY version DESC',
      [projectId],
    );
    return rows.rows.map(toScriptDTO);
  }

  async update(
    id: string,
    fields: { title?: string; content?: string; tone?: string | null; language?: string },
  ): Promise<Row | null> {
    const columns: Record<string, unknown> = {};
    if (fields.title !== undefined) columns.title = fields.title;
    if (fields.content !== undefined) columns.content = fields.content;
    if (fields.tone !== undefined) columns.tone = fields.tone;
    if (fields.language !== undefined) columns.language = fields.language;
    if (Object.keys(columns).length === 0) return this.findById(id);

    const entries = Object.entries(columns);
    const values = entries.map(([, value]) => value);
    const sets = entries.map(([column], index) => `${column} = $${index + 1}`);
    values.push(id);
    return queryOne<Row>(
      `UPDATE scripts SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values,
    );
  }

  async delete(id: string): Promise<boolean> {
    const result = await query('DELETE FROM scripts WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /* -------------------------------- storyboards ------------------------------ */

  async createStoryboard(input: {
    projectId: string;
    title: string;
    shots: StoryboardShot[];
    sourceGenerationId?: string | null;
    createdBy?: string | null;
  }): Promise<Row> {
    const row = await queryOne<Row>(
      `INSERT INTO storyboards (project_id, title, shots, source_generation_id, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        input.projectId,
        input.title,
        JSON.stringify(input.shots),
        input.sourceGenerationId ?? null,
        input.createdBy ?? null,
      ],
    );
    return row!;
  }

  async latestStoryboardForProject(projectId: string): Promise<StoryboardDTO | null> {
    const row = await queryOne<Row>(
      'SELECT * FROM storyboards WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1',
      [projectId],
    );
    return row ? toStoryboardDTO(row) : null;
  }

  async listStoryboardsForProject(projectId: string): Promise<StoryboardDTO[]> {
    const rows = await query<Row>(
      'SELECT * FROM storyboards WHERE project_id = $1 ORDER BY created_at DESC',
      [projectId],
    );
    return rows.rows.map(toStoryboardDTO);
  }

  async findStoryboardById(id: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM storyboards WHERE id = $1', [id]);
  }

  async updateStoryboard(
    id: string,
    fields: { title?: string; shots?: StoryboardShot[] },
  ): Promise<Row | null> {
    const columns: Record<string, unknown> = {};
    if (fields.title !== undefined) columns.title = fields.title;
    if (fields.shots !== undefined) columns.shots = JSON.stringify(fields.shots);
    if (Object.keys(columns).length === 0) return this.findStoryboardById(id);

    const entries = Object.entries(columns);
    const values = entries.map(([, value]) => value);
    const sets = entries.map(([column], index) => `${column} = $${index + 1}`);
    values.push(id);
    return queryOne<Row>(
      `UPDATE storyboards SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values,
    );
  }

  async deleteStoryboard(id: string): Promise<boolean> {
    const result = await query('DELETE FROM storyboards WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
