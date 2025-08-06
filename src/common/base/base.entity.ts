/**
 * The entity roots.
 *
 * `BaseEntity` carries the id and the audit columns every table in `payzeno_api` has
 * (data-model.md conventions block). `updated_at` is maintained by the `set_updated_at()`
 * trigger installed by migration 01 — TypeORM's `@UpdateDateColumn` would fight it, so the
 * column is a plain `@Column` and the database owns the value.
 *
 * Nine entities extend this directly; fourteen extend MerchantScopedEntity.
 */
import { Column, PrimaryColumn } from 'typeorm';

import type { IsoTimestamp } from '@payzeno/contracts';

import {
  currencyTransformer,
  minorUnitsTransformer,
  requiredMinorUnitsTransformer,
  trimmedCharTransformer,
} from '../typeorm/minor-units.transformer';

export abstract class BaseEntity {
  /** `<prefix>_<ULID>`. Minted by IdFactory in the service, never by the database. */
  @PrimaryColumn({ type: 'text', name: 'id' })
  id!: string;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  toIsoCreatedAt(): IsoTimestamp {
    return this.createdAt.toISOString();
  }

  toIsoUpdatedAt(): IsoTimestamp {
    return this.updatedAt.toISOString();
  }
}

/**
 * Immutable tables — `audit_log`, `processed_event`, `event_outbox` — have no `updated_at`
 * and no trigger. Extending BaseEntity would declare a column that does not exist.
 */
export abstract class AppendOnlyEntity {
  @PrimaryColumn({ type: 'text', name: 'id' })
  id!: string;

  @Column({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

export {
  currencyTransformer,
  minorUnitsTransformer,
  requiredMinorUnitsTransformer,
  trimmedCharTransformer,
};
