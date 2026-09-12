/** User persistence. Password hashes are only ever read server-side. */
import type { UserDTO } from '@zyvano/shared';

import { query, queryOne } from '../db/pool';
import { toUserDTO, type Row } from '../db/mappers';

export interface UserRecord extends Row {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  email_verified_at: Date | null;
}

export class UserRepository {
  async findById(id: string): Promise<UserRecord | null> {
    return queryOne<UserRecord>('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [id]);
  }

  /** Returns the internal record (including password_hash) for authentication. */
  async findByEmail(email: string): Promise<UserRecord | null> {
    return queryOne<UserRecord>('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  }

  async findDTOById(id: string): Promise<UserDTO | null> {
    const row = await this.findById(id);
    return row ? toUserDTO(row) : null;
  }

  async existsByEmail(email: string): Promise<boolean> {
    const row = await queryOne<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM users WHERE email = $1) AS exists',
      [email],
    );
    return row?.exists ?? false;
  }

  async create(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    emailVerifiedAt?: Date | null;
  }): Promise<UserRecord> {
    const row = await queryOne<UserRecord>(
      `INSERT INTO users (email, display_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.email, input.displayName, input.passwordHash, input.emailVerifiedAt ?? null],
    );
    return row!;
  }

  async updateProfile(
    id: string,
    fields: { displayName?: string; avatarUrl?: string | null },
  ): Promise<UserRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.displayName !== undefined) {
      values.push(fields.displayName);
      sets.push(`display_name = $${values.length}`);
    }
    if (fields.avatarUrl !== undefined) {
      values.push(fields.avatarUrl);
      sets.push(`avatar_url = $${values.length}`);
    }
    if (sets.length === 0) return this.findById(id);

    values.push(id);
    return queryOne<UserRecord>(
      `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values,
    );
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
      id,
      passwordHash,
    ]);
  }

  async markEmailVerified(id: string): Promise<void> {
    await query(
      'UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now() WHERE id = $1',
      [id],
    );
  }

  async recordLoginSuccess(id: string): Promise<void> {
    await query(
      'UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1',
      [id],
    );
  }

  /**
   * Increments the failure counter and locks the account after `threshold`
   * consecutive failures, defending against online brute force.
   */
  async recordLoginFailure(id: string, threshold: number, lockMinutes: number): Promise<void> {
    await query(
      `UPDATE users
         SET failed_login_count = failed_login_count + 1,
             locked_until = CASE
               WHEN failed_login_count + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
               ELSE locked_until
             END,
             updated_at = now()
       WHERE id = $1`,
      [id, threshold, String(lockMinutes)],
    );
  }

  async isLocked(id: string): Promise<boolean> {
    const row = await queryOne<{ locked: boolean }>(
      'SELECT (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM users WHERE id = $1',
      [id],
    );
    return row?.locked ?? false;
  }

  async softDelete(id: string): Promise<void> {
    await query(
      `UPDATE users
         SET status = 'deleted',
             deleted_at = now(),
             email = CONCAT('deleted+', id::text, '@zyvano.invalid'),
             display_name = 'Deleted user',
             password_hash = 'invalidated',
             updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }
}
