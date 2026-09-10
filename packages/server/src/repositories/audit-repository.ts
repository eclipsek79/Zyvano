/** Append-only audit trail. */
import { query, queryOne } from '../db/pool';
import { toAuditEventDTO, type Row } from '../db/mappers';
import type { AuditCategory, AuditEventDTO } from '@zyvano/shared';

export interface AuditListFilters {
  organizationId: string;
  category?: string | undefined;
  action?: string | undefined;
  resourceId?: string | undefined;
  page: number;
  perPage: number;
}

export class AuditRepository {
  async record(input: {
    organizationId?: string | null;
    actorUserId?: string | null;
    actorEmail?: string | null;
    category: AuditCategory;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
    requestId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await query(
      `INSERT INTO audit_events
         (organization_id, actor_user_id, actor_email, category, action, resource_type,
          resource_id, ip_address, user_agent, request_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.organizationId ?? null,
        input.actorUserId ?? null,
        input.actorEmail ?? null,
        input.category,
        input.action,
        input.resourceType ?? null,
        input.resourceId ?? null,
        // `inet` rejects empty strings, so an unknown address is stored as NULL.
        input.ipAddress && input.ipAddress.length > 0 ? input.ipAddress : null,
        input.userAgent ?? null,
        input.requestId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  }

  async list(filters: AuditListFilters): Promise<{ items: AuditEventDTO[]; total: number }> {
    const conditions = ['organization_id = $1'];
    const params: unknown[] = [filters.organizationId];
    if (filters.category) {
      params.push(filters.category);
      conditions.push(`category = $${params.length}`);
    }
    if (filters.action) {
      params.push(filters.action);
      conditions.push(`action = $${params.length}`);
    }
    if (filters.resourceId) {
      params.push(filters.resourceId);
      conditions.push(`resource_id = $${params.length}`);
    }
    const where = conditions.join(' AND ');
    const offset = (filters.page - 1) * filters.perPage;

    const [rows, countRow] = await Promise.all([
      query<Row>(
        `SELECT * FROM audit_events WHERE ${where} ORDER BY created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, filters.perPage, offset],
      ),
      queryOne<{ count: string }>(`SELECT COUNT(*)::text AS count FROM audit_events WHERE ${where}`, params),
    ]);
    return { items: rows.rows.map(toAuditEventDTO), total: Number(countRow?.count ?? 0) };
  }

  async recentForOrganization(organizationId: string, limit = 20): Promise<AuditEventDTO[]> {
    const rows = await query<Row>(
      'SELECT * FROM audit_events WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2',
      [organizationId, limit],
    );
    return rows.rows.map(toAuditEventDTO);
  }
}
