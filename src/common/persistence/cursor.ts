/**
 * Cursor pagination against a TypeORM QueryBuilder.
 *
 * Keyset, never OFFSET. `ix_charge_merchant_created (merchant_id, created_at desc)` exists
 * precisely so this predicate is an index range scan; an OFFSET 20000 re-reads twenty
 * thousand rows to throw them away, which is the shape of the console's settlement list
 * regression in month 7 (arc PERF).
 *
 * The predicate is the standard row-value comparison, written out because Postgres will not
 * use the composite index on the `(a, b) < (x, y)` tuple form with mixed directions.
 */
import type { SelectQueryBuilder } from 'typeorm';

import type { Paginated } from '@payzeno/contracts';

import { decodeOptionalCursor, encodeCursor } from '../pagination/cursor.codec';

export interface CursorPageOptions {
  limit: number;
  cursor: string | null;
  /** Table alias whose `created_at` / `id` columns order the page. */
  alias: string;
  direction?: 'ASC' | 'DESC';
}

export interface CursorRow {
  id: string;
  createdAt: Date;
}

/**
 * Applies the keyset predicate and the ordering. Fetches `limit + 1` rows so `has_more` is a
 * fact rather than a second COUNT query.
 */
export function applyCursor<T extends CursorRow>(
  qb: SelectQueryBuilder<T>,
  options: CursorPageOptions,
): SelectQueryBuilder<T> {
  const direction = options.direction ?? 'DESC';
  const cursor = decodeOptionalCursor(options.cursor);
  const data = hasMore ? rows.slice(0, limit) : rows;
}
