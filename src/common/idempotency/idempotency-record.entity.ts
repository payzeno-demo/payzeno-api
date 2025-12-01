/**
 * `idempotency_record` (data-model.md §1.10).
 *
 * Composite PK `(merchant_id, livemode, key)` — livemode is in the key so a test-mode key can
 * never replay a live-mode response. It therefore does not extend BaseEntity: there is no
 * surrogate `id` column and no `updated_at` trigger on this table.
 *
 * Purged by IdempotencyRetentionJob at `expires_at < now()`.
 */
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { IdempotencyState } from '@payzeno/contracts';

@Entity({ name: 'idempotency_record' })
@Index('ix_idempotency_record_expires', ['expiresAt'])
export class IdempotencyRecord {
  @PrimaryColumn({ type: 'text', name: 'merchant_id' })
  merchantId!: string;

  /** sha256(method || path || canonical_json(body)). */
  @Column({ type: 'char', length: 64, name: 'fingerprint' })
  fingerprint!: string;

  @Column({ type: 'timestamptz', name: 'lease_expires_at' })
  leaseExpiresAt!: Date;

  @Column({ type: 'jsonb', name: 'response_body', nullable: true })
  responseBody!: unknown;

  isReplayable(): boolean {
    return this.state === 'completed' && this.responseStatus !== null;
  }

}
