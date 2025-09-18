/**
 * `dispute` — data-model.md §1.8, plus the two fee-schedule tables it reads.
 *
 * `fee_minor` has **no default**. A currency-blind `default 1500` is $15 in USD and about $10
 * in JPY, and the chargeback fee is an acquirer/region contract term. It is looked up from
 * `dispute_fee_schedule` at creation time by `DisputeFeeService`.
 *
 * `uq_dispute_charge_open` is a partial unique index over `(charge_id)` where the status is
 * still open. It is what turns a redelivered `dispute_opened` acquirer webhook into a 23505
 * and then into `DuplicateDisputeException`, instead of a second chargeback liability posting.
 */

import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import type {
  Acquirer,
  ChargeId,
  CurrencyCode,
  DisputeEvidence,
  DisputeReason,
  DisputeStatus,
  IsoDate,
} from '@payzeno/contracts';

import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { currencyTransformer, requiredMinorUnitsTransformer } from '../common/typeorm/minor-units.transformer';
import { ChargeEntity } from '../payments/charge.entity';

@Entity({ name: 'dispute' })
@Index('uq_dispute_charge_open', ['charge_id'], {
  unique: true,
  where: "status in ('needs_response','under_review')",
})
@Index('ix_dispute_merchant_status', ['merchant_id', 'status'])
@Index('pix_dispute_evidence_due', ['evidence_due_by'], { where: "status = 'needs_response'" })
export class DisputeEntity extends MerchantScopedEntity {
  @Column({ type: 'text' })
  charge_id: ChargeId;

  /** The raw scheme code (`10.4`, `13.1`, …). Kept verbatim; the enum above is our mapping. */
  @Column({ type: 'varchar', length: 8 })
  network_reason_code: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  evidence: DisputeEvidence;

  @Column({ type: 'boolean', default: false })
  is_charge_refundable: boolean;

  isOpen(): boolean {
    return this.status === 'needs_response' || this.status === 'under_review';
  }

  @PrimaryColumn({ type: 'date' })
  effective_from: IsoDate;

}
