/**
 * Repository base helpers.
 *
 * Repositories are the only layer allowed to build SQL. They must use
 * parameterized statements; `buildUpdateSet` exists so dynamic updates never
 * tempt a caller into string-interpolating values.
 */
import type { PoolClient, QueryResultRow } from 'pg';

import { query, queryOne, withTransaction } from './pool';

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Guards column names used in dynamic ORDER BY / SET clauses. */
export function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${name}`);
  }
  return name;
}

export function buildUpdateSet(
  fields: Record<string, unknown>,
  startingIndex = 1,
): { clause: string; values: unknown[] } {
  const keys = Object.keys(fields);
  if (keys.length === 0) throw new Error('buildUpdateSet requires at least one field');

  const values: unknown[] = [];
  const assignments = keys.map((key, offset) => {
    values.push(fields[key]);
    return `${assertIdentifier(key)} = $${startingIndex + offset}`;
  });

  return { clause: assignments.join(', '), values };
}

/**
 * Builds a `LIMIT/OFFSET` paginated query. `countSql` must select `count(*)`.
 */
export async function paginate<T extends QueryResultRow>(
  sql: string,
  countSql: string,
  params: unknown[],
  page: number,
  perPage: number,
): Promise<Paginated<T>> {
  const offset = (page - 1) * perPage;
  const [rows, countRow] = await Promise.all([
    query<T>(`${sql} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [
      ...params,
      perPage,
      offset,
    ]),
    queryOne<{ count: string }>(countSql, params),
  ]);

  return {
    items: rows.rows,
    total: Number(countRow?.count ?? 0),
    page,
    perPage,
  };
}

export abstract class BaseRepository {
  protected abstract readonly table: string;

  protected async findById<T extends QueryResultRow>(id: string): Promise<T | null> {
    return queryOne<T>(`SELECT * FROM ${assertIdentifier(this.table)} WHERE id = $1`, [id]);
  }

  protected async deleteById(id: string): Promise<boolean> {
    const result = await query(`DELETE FROM ${assertIdentifier(this.table)} WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  protected async exists(id: string): Promise<boolean> {
    const row = await queryOne<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM ${assertIdentifier(this.table)} WHERE id = $1) AS exists`,
      [id],
    );
    return row?.exists ?? false;
  }

  /** Exposes the transaction helper to subclasses that need multi-statement writes. */
  protected transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(fn);
  }
}
