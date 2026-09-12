/** Single-use, expiring tokens for email verification and password reset. */
import { query, queryOne } from '../db/pool';
import type { Row } from '../db/mappers';

export class AuthTokenRepository {
  async create(input: {
    userId: string;
    kind: 'email_verification' | 'password_reset';
    tokenHash: string;
    expiresInMinutes: number;
  }): Promise<void> {
    // Any previously issued token of the same kind is invalidated first, so only
    // the most recently emailed link can be used.
    await query(
      'UPDATE auth_tokens SET consumed_at = now() WHERE user_id = $1 AND kind = $2 AND consumed_at IS NULL',
      [input.userId, input.kind],
    );
    await query(
      `INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
      [input.userId, input.kind, input.tokenHash, String(input.expiresInMinutes)],
    );
  }

  /**
   * Atomically consumes a token. The `consumed_at IS NULL` predicate inside the
   * UPDATE is what makes redemption single-use even under concurrent requests.
   */
  async consume(kind: 'email_verification' | 'password_reset', tokenHash: string): Promise<Row | null> {
    return queryOne<Row>(
      `UPDATE auth_tokens
          SET consumed_at = now()
        WHERE token_hash = $1 AND kind = $2 AND consumed_at IS NULL AND expires_at > now()
        RETURNING *`,
      [tokenHash, kind],
    );
  }

  async deleteExpired(olderThanDays = 7): Promise<number> {
    const result = await query(
      `DELETE FROM auth_tokens WHERE expires_at < now() - ($1 || ' days')::interval`,
      [String(olderThanDays)],
    );
    return result.rowCount ?? 0;
  }
}
