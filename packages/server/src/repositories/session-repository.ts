/** Session persistence. Only token hashes are stored. */
import { query, queryOne } from '../db/pool';
import type { Row } from '../db/mappers';

export interface SessionRecord extends Row {
  id: string;
  user_id: string;
  token_hash: string;
  csrf_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_at: Date;
}

export class SessionRepository {
  async create(input: {
    userId: string;
    tokenHash: string;
    csrfTokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ipAddress?: string | null;
  }): Promise<SessionRecord> {
    const row = await queryOne<SessionRecord>(
      `INSERT INTO sessions (user_id, token_hash, csrf_token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.userId,
        input.tokenHash,
        input.csrfTokenHash,
        input.expiresAt,
        input.userAgent ?? null,
        input.ipAddress ?? null,
      ],
    );
    return row!;
  }

  /**
   * Resolves a live session by token hash. Expired or revoked sessions are never
   * returned, so a stolen-but-expired cookie cannot be replayed.
   */
  async findActiveByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return queryOne<SessionRecord>(
      `SELECT * FROM sessions
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash],
    );
  }

  async touch(id: string): Promise<void> {
    // `used_at` is deliberately throttled: writing on every request would turn a
    // read-only API call into a write. One update per 5 minutes is plenty.
    await query(
      `UPDATE sessions SET last_used_at = now()
        WHERE id = $1 AND last_used_at < now() - interval '5 minutes'`,
      [id],
    );
  }

  /** Rotates the opaque token in place, invalidating the previous value. */
  async rotate(id: string, tokenHash: string, csrfTokenHash: string, expiresAt: Date): Promise<void> {
    await query(
      `UPDATE sessions
          SET token_hash = $2, csrf_token_hash = $3, expires_at = $4, rotated_at = now()
        WHERE id = $1 AND revoked_at IS NULL`,
      [id, tokenHash, csrfTokenHash, expiresAt],
    );
  }

  async revoke(id: string): Promise<void> {
    await query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const result = await query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    return result.rowCount ?? 0;
  }

  async listActiveForUser(userId: string): Promise<SessionRecord[]> {
    const result = await query<SessionRecord>(
      `SELECT * FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY last_used_at DESC`,
      [userId],
    );
    return result.rows;
  }

  /** Retention: physically removes long-expired rows. */
  async deleteExpired(olderThanDays = 30): Promise<number> {
    const result = await query(
      `DELETE FROM sessions WHERE expires_at < now() - ($1 || ' days')::interval`,
      [String(olderThanDays)],
    );
    return result.rowCount ?? 0;
  }
}
