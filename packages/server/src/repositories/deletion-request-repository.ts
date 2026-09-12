/**
 * Durable ledger of data-deletion work.
 *
 * A deletion is a multi-step operation spanning database rows and object storage, so
 * the *intent* is recorded before any of it runs. That is what lets the operation
 * survive a process restart: the `DeleteUserData` job consumes this table, and a
 * request that was interrupted is still discoverable as `pending`/`processing`.
 *
 * The table is never hard-deleted by the application — it is described in its own
 * migration as "an explicit, auditable record of data-deletion work", so it is
 * deliberately not truncated between tests.
 */
import type { PoolClient } from 'pg';

import { query, queryOne } from '../db/pool';
import type { Row } from '../db/mappers';

export type DeletionScope = 'account' | 'project' | 'asset' | 'export' | 'organization';
export type DeletionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface DeletionRequestRecord extends Row {
  id: string;
  scope: DeletionScope;
  status: DeletionStatus;
  user_id: string | null;
  organization_id: string | null;
  node_count: number;
  bytes_reclaimed: number;
  attempts: number;
}

export class DeletionRequestRepository {
  async create(input: {
    scope: DeletionScope;
    userId?: string | null;
    organizationId?: string | null;
    projectId?: string | null;
    reason?: string | null;
    requestedBy?: string | null;
    client?: PoolClient;
  }): Promise<DeletionRequestRecord> {
    const sql = `INSERT INTO deletion_requests
                   (scope, user_id, organization_id, project_id, reason, requested_by)
                 VALUES ($1,$2,$3,$4,$5,$6)
                 RETURNING *`;
    const params = [
      input.scope,
      input.userId ?? null,
      input.organizationId ?? null,
      input.projectId ?? null,
      input.reason ?? null,
      input.requestedBy ?? null,
    ];
    if (input.client) {
      const result = await input.client.query<DeletionRequestRecord>(sql, params);
      return result.rows[0]!;
    }
    return (await queryOne<DeletionRequestRecord>(sql, params))!;
  }

  async findById(id: string): Promise<DeletionRequestRecord | null> {
    return queryOne<DeletionRequestRecord>('SELECT * FROM deletion_requests WHERE id = $1', [id]);
  }

  /** Claims a pending request. Returns null when another worker got there first. */
  async claim(id: string): Promise<DeletionRequestRecord | null> {
    return queryOne<DeletionRequestRecord>(
      `UPDATE deletion_requests
          SET status = 'processing', started_at = COALESCE(started_at, now()),
              attempts = attempts + 1
        WHERE id = $1 AND status IN ('pending', 'failed')
        RETURNING *`,
      [id],
    );
  }

  async markCompleted(
    id: string,
    summary: { nodeCount: number; bytesReclaimed: number },
  ): Promise<void> {
    await query(
      `UPDATE deletion_requests
          SET status = 'completed', completed_at = now(), last_error = NULL,
              node_count = $2, bytes_reclaimed = $3
        WHERE id = $1`,
      [id, summary.nodeCount, summary.bytesReclaimed],
    );
  }

  async markFailed(id: string, error: string): Promise<void> {
    await query(
      "UPDATE deletion_requests SET status = 'failed', last_error = $2 WHERE id = $1",
      [id, error.slice(0, 2000)],
    );
  }

  /** Requests still owing work, oldest first. Drives replay after a crash. */
  async listPending(limit = 50): Promise<DeletionRequestRecord[]> {
    const result = await query<DeletionRequestRecord>(
      `SELECT * FROM deletion_requests
        WHERE status IN ('pending', 'processing')
        ORDER BY created_at ASC
        LIMIT $1`,
      [limit],
    );
    return result.rows;
  }

  /** The most recent request for a user, used to report progress to its owner. */
  async latestForUser(userId: string): Promise<DeletionRequestRecord | null> {
    return queryOne<DeletionRequestRecord>(
      `SELECT * FROM deletion_requests
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );
  }

  /**
   * Removes native account rows the account-deletion flow owns.
   *
   * Scoped strictly to `user_id = $1` so it can only ever destroy the target
   * account's own security state, never another user's.
   */
  async purgeUserNativeRows(userId: string): Promise<void> {
    await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await query('DELETE FROM auth_tokens WHERE user_id = $1', [userId]);
    await query('DELETE FROM auth_attempts WHERE identifier = $1', [userId]);
    await query('DELETE FROM api_keys WHERE created_by = $1', [userId]);
    await query('DELETE FROM organization_invitations WHERE invited_by = $1', [userId]);
  }
}
