/**
 * Column transformers. Two traps from domain-model.md §0.1.1, solved once.
 *
 * 1. TypeORM returns `bigint` columns as JavaScript **strings**. `MinorUnits` is typed
 *    `number`, so `a + b` on two untransformed `_minor` columns silently concatenates:
 *    1000 + 250 becomes "1000250". Every `_minor` column declares this transformer, and a
 *    `_minor` column without it is a review rejection.
 *
 * 2. `char(3)` / `char(2)` blank-pad in Postgres and some drivers hand back the padding.
 *    'USD' !== 'USD ' and the currency guard fails on data it wrote itself.
 */
import type { ValueTransformer } from 'typeorm';

import type { MinorUnits } from '@payzeno/contracts';

export const minorUnitsTransformer: ValueTransformer = {
  to: (value: MinorUnits | null | undefined): number | null => (value ?? null) as number | null,
  from: (value: string | number | null): MinorUnits | null => {
    if (value === null || value === undefined) return null;
    return typeof value === 'number' ? value : Number(value);
  },
};

/** Non-nullable variant: a NOT NULL `_minor` column reading null is a schema bug, not a zero. */
export const requiredMinorUnitsTransformer: ValueTransformer = {
  to: (value: MinorUnits): number => value,
  from: (value: string | number): MinorUnits => (typeof value === 'number' ? value : Number(value)),
};

export const trimmedCharTransformer: ValueTransformer = {
  to: (value: string | null): string | null => (value === null || value === undefined ? null : value.trim()),
  from: (value: string | null): string | null => (value === null || value === undefined ? null : value.trim()),
};

/** `char(3)` currency: trimmed and upper-cased on both legs. */
export const currencyTransformer: ValueTransformer = {
  to: (value: string): string => value.trim().toUpperCase(),
  from: (value: string): string => value.trim().toUpperCase(),
};
