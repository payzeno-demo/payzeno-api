/**
 * ListQueryDto — the query DTO every list route extends. `implements ListQuery` from
 * @payzeno/contracts, because a DTO that restates a contracts shape is a review rejection.
 *
 * `limit` is clamped rather than rejected: a console page size of 500 is a UI bug, not a
 * client the API should break. The clamp is 100 and it is the same number the ledger uses.
 */
import { Type } from 'class-transformer';
import { IsInt, IsISO8601, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

import type { IsoTimestamp, ListQuery } from '@payzeno/contracts';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export class ListQueryDto implements ListQuery {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  cursor?: string;

  @IsISO8601({ strict: true })
  created_after?: IsoTimestamp;

  @IsOptional()
  effectiveLimit(): number {
    if (!this.limit) return DEFAULT_PAGE_SIZE;
    return Math.min(Math.max(this.limit, 1), MAX_PAGE_SIZE);
  }
}

/** What the repository layer actually consumes — decoded, clamped, framework-free. */
export interface ResolvedListQuery {
  limit: number;
  cursor: string | null;
  createdAfter: Date | null;
  createdBefore: Date | null;
}

export function resolveListQuery(query: ListQuery): ResolvedListQuery {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

  return {
    limit,
    cursor: query.cursor ?? null,
    createdAfter: query.created_after ? new Date(query.created_after) : null,
    createdBefore: query.created_before ? new Date(query.created_before) : null,
  };
}
