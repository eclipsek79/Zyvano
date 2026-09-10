/** In-app notifications. */
import { query, queryOne } from '../db/pool';
import { toNotificationDTO, type Row } from '../db/mappers';
import type { NotificationDTO } from '@zyvano/shared';

export class NotificationRepository {
  async create(input: {
    userId: string;
    organizationId?: string | null;
    type: string;
    title: string;
    body?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
  }): Promise<Row> {
    const row = await queryOne<Row>(
      `INSERT INTO notifications (user_id, organization_id, type, title, body, resource_type, resource_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        input.userId,
        input.organizationId ?? null,
        input.type,
        input.title,
        input.body ?? null,
        input.resourceType ?? null,
        input.resourceId ?? null,
      ],
    );
    return row!;
  }

  async listForUser(userId: string, limit = 50): Promise<NotificationDTO[]> {
    const rows = await query<Row>(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit],
    );
    return rows.rows.map(toNotificationDTO);
  }

  async markRead(userId: string, id: string): Promise<boolean> {
    const result = await query(
      'UPDATE notifications SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL',
      [id, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markAllRead(userId: string): Promise<number> {
    const result = await query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL',
      [userId],
    );
    return result.rowCount ?? 0;
  }

  async countUnread(userId: string): Promise<number> {
    const row = await queryOne<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM notifications WHERE user_id = $1 AND read_at IS NULL',
      [userId],
    );
    return Number(row?.count ?? 0);
  }
}
