/** Templates: system-provided plus organization-owned. */
import { query, queryOne } from '../db/pool';
import { toTemplateDTO, type Row } from '../db/mappers';
import type { TemplateDTO } from '@zyvano/shared';

export class TemplateRepository {
  /** Returns system templates plus the organization's own, alphabetically. */
  async listForOrganization(input: {
    organizationId: string;
    category?: string | undefined;
    page: number;
    perPage: number;
  }): Promise<{ items: TemplateDTO[]; total: number }> {
    const conditions = ['deleted_at IS NULL', '(organization_id IS NULL OR organization_id = $1)'];
    const params: unknown[] = [input.organizationId];
    if (input.category) {
      params.push(input.category);
      conditions.push(`category = $${params.length}`);
    }
    const where = conditions.join(' AND ');
    const offset = (input.page - 1) * input.perPage;

    const [rows, countRow] = await Promise.all([
      query<Row>(
        `SELECT * FROM templates WHERE ${where} ORDER BY is_system DESC, name ASC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, input.perPage, offset],
      ),
      queryOne<{ count: string }>(`SELECT COUNT(*)::text AS count FROM templates WHERE ${where}`, params),
    ]);
    return { items: rows.rows.map(toTemplateDTO), total: Number(countRow?.count ?? 0) };
  }

  async findById(id: string): Promise<Row | null> {
    return queryOne<Row>('SELECT * FROM templates WHERE id = $1 AND deleted_at IS NULL', [id]);
  }

  /** A template is usable when it is a system template or owned by the caller's org. */
  async findUsableById(id: string, organizationId: string): Promise<Row | null> {
    return queryOne<Row>(
      `SELECT * FROM templates
        WHERE id = $1 AND deleted_at IS NULL
          AND (organization_id IS NULL OR organization_id = $2)`,
      [id, organizationId],
    );
  }

  async create(input: {
    organizationId: string | null;
    name: string;
    slug: string;
    description?: string | null;
    category: string;
    aspectRatio: string;
    defaultDurationSeconds: number;
    definition: Record<string, unknown>;
    isSystem: boolean;
    createdBy?: string | null;
  }): Promise<Row> {
    const row = await queryOne<Row>(
      `INSERT INTO templates
         (organization_id, name, slug, description, category, aspect_ratio,
          default_duration_seconds, definition, is_system, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        input.organizationId,
        input.name,
        input.slug,
        input.description ?? null,
        input.category,
        input.aspectRatio,
        input.defaultDurationSeconds,
        JSON.stringify(input.definition),
        input.isSystem,
        input.createdBy ?? null,
      ],
    );
    return row!;
  }

  /** Idempotent system-template seeding (runs at startup for the default catalog). */
  async upsertSystemTemplate(input: {
    name: string;
    slug: string;
    description: string;
    category: string;
    aspectRatio: string;
    defaultDurationSeconds: number;
    definition: Record<string, unknown>;
  }): Promise<void> {
    await query(
      // The inference clause must state the same expression AND the same predicate as
      // the index (`templates_slug_unique`, which is partial on `deleted_at IS NULL`).
      // Without the predicate PostgreSQL cannot match the index and rejects the
      // statement outright, which is exactly what prevented the catalog from seeding.
      `INSERT INTO templates
         (organization_id, name, slug, description, category, aspect_ratio,
          default_duration_seconds, definition, is_system)
       VALUES (NULL,$1,$2,$3,$4,$5,$6,$7,true)
       ON CONFLICT (COALESCE(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), slug)
         WHERE deleted_at IS NULL
         DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
                       category = EXCLUDED.category, aspect_ratio = EXCLUDED.aspect_ratio,
                       default_duration_seconds = EXCLUDED.default_duration_seconds,
                       definition = EXCLUDED.definition, updated_at = now()`,
      [
        input.name,
        input.slug,
        input.description,
        input.category,
        input.aspectRatio,
        input.defaultDurationSeconds,
        JSON.stringify(input.definition),
      ],
    );
  }
}
