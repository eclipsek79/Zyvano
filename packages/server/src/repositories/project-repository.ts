/** Projects and project membership. */
import { query, queryOne } from '../db/pool';
import { toProjectDTO, type Row } from '../db/mappers';
import type { Paginated } from '../db/repository';
import type { OrgRole, ProjectDTO, ProjectStatus } from '@zyvano/shared';

export interface ProjectRecord extends Row {
  id: string;
  organization_id: string;
  owner_id: string;
  name: string;
  status: ProjectStatus;
  aspect_ratio: string;
}

export interface ProjectListFilters {
  organizationId: string;
  status?: ProjectStatus | undefined;
  /** Restricts the list to projects owned by one user (account-deletion scrub). */
  ownerId?: string | undefined;
  search?: string | undefined;
  sort?: string | undefined;
  order?: 'asc' | 'desc' | undefined;
  page: number;
  perPage: number;
}

/** Columns a client may sort by. Anything else is rejected. */
const SORTABLE: Record<string, string> = {
  createdAt: 'p.created_at',
  updatedAt: 'p.updated_at',
  name: 'p.name',
  status: 'p.status',
};

const COUNT_SUBSELECTS = `
  (SELECT COUNT(*) FROM scenes s WHERE s.project_id = p.id) AS scene_count,
  (SELECT COUNT(*) FROM assets a WHERE a.project_id = p.id AND a.deleted_at IS NULL) AS asset_count,
  (SELECT COUNT(*) FROM generations g WHERE g.project_id = p.id) AS generation_count,
  (SELECT COUNT(*) FROM exports e WHERE e.project_id = p.id) AS export_count
`;

export class ProjectRepository {
  async create(input: {
    organizationId: string;
    ownerId: string;
    name: string;
    description?: string | null;
    prompt?: string | null;
    aspectRatio: string;
    targetDurationSeconds?: number | null;
  }): Promise<ProjectRecord> {
    const row = await queryOne<ProjectRecord>(
      `INSERT INTO projects
         (organization_id, owner_id, name, description, prompt, aspect_ratio, target_duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.organizationId,
        input.ownerId,
        input.name,
        input.description ?? null,
        input.prompt ?? null,
        input.aspectRatio,
        input.targetDurationSeconds ?? null,
      ],
    );
    return row!;
  }

  async findById(id: string): Promise<ProjectRecord | null> {
    return queryOne<ProjectRecord>('SELECT * FROM projects WHERE id = $1 AND deleted_at IS NULL', [id]);
  }

  /** Detail read with aggregate counts, used by the project workspace header. */
  async findDetailById(id: string): Promise<ProjectDTO | null> {
    const row = await queryOne<Row>(
      `SELECT p.*, ${COUNT_SUBSELECTS} FROM projects p WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [id],
    );
    return row ? toProjectDTO(row) : null;
  }

  async list(filters: ProjectListFilters): Promise<Paginated<ProjectDTO>> {
    const conditions: string[] = ['p.organization_id = $1', 'p.deleted_at IS NULL'];
    const params: unknown[] = [filters.organizationId];

    if (filters.status) {
      params.push(filters.status);
      conditions.push(`p.status = $${params.length}`);
    }
    if (filters.ownerId) {
      params.push(filters.ownerId);
      conditions.push(`p.owner_id = $${params.length}`);
    }
    if (filters.search) {
      params.push(`%${filters.search}%`);
      conditions.push(`(p.name ILIKE $${params.length} OR p.description ILIKE $${params.length})`);
    }

    const where = conditions.join(' AND ');
    const sortColumn = SORTABLE[filters.sort ?? 'createdAt'] ?? SORTABLE.createdAt;
    const direction = filters.order === 'asc' ? 'ASC' : 'DESC';
    const offset = (filters.page - 1) * filters.perPage;

    const [rows, countRow] = await Promise.all([
      query<Row>(
        `SELECT p.*, ${COUNT_SUBSELECTS}
           FROM projects p
          WHERE ${where}
          ORDER BY ${sortColumn} ${direction}
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.perPage, offset],
      ),
      queryOne<{ count: string }>(`SELECT COUNT(*)::text AS count FROM projects p WHERE ${where}`, params),
    ]);

    return {
      items: rows.rows.map(toProjectDTO),
      total: Number(countRow?.count ?? 0),
      page: filters.page,
      perPage: filters.perPage,
    };
  }

  async update(
    id: string,
    fields: {
      name?: string;
      description?: string | null;
      prompt?: string | null;
      aspectRatio?: string;
      targetDurationSeconds?: number | null;
      status?: string;
    },
  ): Promise<ProjectRecord | null> {
    const columns: Record<string, unknown> = {};
    if (fields.name !== undefined) columns.name = fields.name;
    if (fields.description !== undefined) columns.description = fields.description;
    if (fields.prompt !== undefined) columns.prompt = fields.prompt;
    if (fields.aspectRatio !== undefined) columns.aspect_ratio = fields.aspectRatio;
    if (fields.targetDurationSeconds !== undefined) {
      columns.target_duration_seconds = fields.targetDurationSeconds;
    }
    if (fields.status !== undefined) columns.status = fields.status;
    if (Object.keys(columns).length === 0) return this.findById(id);

    const entries = Object.entries(columns);
    const values = entries.map(([, value]) => value);
    const sets = entries.map(([column], index) => `${column} = $${index + 1}`);
    values.push(id);

    return queryOne<ProjectRecord>(
      `UPDATE projects SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${values.length} AND deleted_at IS NULL RETURNING *`,
      values,
    );
  }

  async softDelete(id: string): Promise<void> {
    await query(
      "UPDATE projects SET deleted_at = now(), status = 'deleted', updated_at = now() WHERE id = $1",
      [id],
    );
  }

  /** Storage keys of every asset owned by a project — used before hard deletion. */
  async listAssetStorageKeys(projectId: string): Promise<string[]> {
    const rows = await query<{ storage_key: string; thumbnail_key: string | null }>(
      'SELECT storage_key, thumbnail_key FROM assets WHERE project_id = $1',
      [projectId],
    );
    const keys: string[] = [];
    for (const row of rows.rows) {
      keys.push(row.storage_key);
      if (row.thumbnail_key) keys.push(row.thumbnail_key);
    }
    return keys;
  }

  /* ----------------------------- project members ---------------------------- */

  async addMember(input: {
    projectId: string;
    userId: string;
    role: OrgRole;
    addedBy: string;
  }): Promise<void> {
    await query(
      `INSERT INTO project_members (project_id, user_id, role, added_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()`,
      [input.projectId, input.userId, input.role, input.addedBy],
    );
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    const result = await query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [
      projectId,
      userId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  async getMemberRole(projectId: string, userId: string): Promise<OrgRole | null> {
    const row = await queryOne<{ role: OrgRole }>(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [projectId, userId],
    );
    return row?.role ?? null;
  }

  async listMembers(projectId: string): Promise<Row[]> {
    const result = await query(
      `SELECT pm.user_id, pm.role, pm.created_at, u.email, u.display_name
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = $1
        ORDER BY pm.created_at ASC`,
      [projectId],
    );
    return result.rows;
  }
}
