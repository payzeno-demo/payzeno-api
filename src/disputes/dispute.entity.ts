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

  @ManyToOne(() => ChargeEntity)
  @JoinColumn({ name: 'charge_id' })
  charge?: ChargeEntity;

  @Column({ type: 'bigint', transformer: requiredMinorUnitsTransformer })
  amount_minor: number;

  /** Looked up, never defaulted. See DisputeFeeService. */
  @Column({ type: 'bigint', transformer: requiredMinorUnitsTransformer })
  fee_minor: number;

  @Column({ type: 'char', length: 3, transformer: currencyTransformer })
  currency: CurrencyCode;

  @Column({
    type: 'enum',
    enum: [
      'needs_response',
      'under_review',
      'won',
      'lost',
      'warning_needs_response',
      'warning_closed',
    ],
    enumName: 'dispute_status',
  })
  status: DisputeStatus;

  @Column({
    type: 'enum',
    enum: [
      'fraudulent',
      'product_not_received',
      'product_unacceptable',
      'duplicate',
      'subscription_canceled',
      'credit_not_processed',
      'general',
    ],
    enumName: 'dispute_reason',
  })
  reason: DisputeReason;

  /** The raw scheme code (`10.4`, `13.1`, …). Kept verbatim; the enum above is our mapping. */
  @Column({ type: 'varchar', length: 8 })
  network_reason_code: string;

  @Column({ type: 'timestamptz', nullable: true })
  evidence_due_by: Date | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  evidence: DisputeEvidence;

  @Column({ type: 'boolean', default: false })
  is_charge_refundable: boolean;

  /** Copied from `charge.three_d_secure.liability_shifted` at creation. */
  @Column({ type: 'boolean', default: false })
  liability_shifted: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  submitted_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolved_at: Date | null;

  isOpen(): boolean {
    return this.status === 'needs_response' || this.status === 'under_review';
  }

  /** How many evidence fields the merchant actually filled — carried on the bus event. */
  evidenceFieldCount(): number {
    return Object.values(this.evidence ?? {}).filter(
      (value) => typeof value === 'string' && value.trim().length > 0,
    ).length;
  }

  /** The issuer already ate the loss; the console says so instead of asking for evidence. */
  isIssuerLiability(): boolean {
    return this.liability_shifted && this.reason === 'fraudulent';
  }
}

/**
 * `dispute_fee_schedule` — the acquirer's chargeback fee, per currency, effective-dated.
 * Read-only from payzeno-api's point of view: rows are loaded by migration 09 and amended by
 * finance through a runbook, never by a handler.
 */
@Entity({ name: 'dispute_fee_schedule' })
export class DisputeFeeScheduleEntity {
  @PrimaryColumn({ type: 'enum', enum: ['worldflow', 'nordpay'], enumName: 'acquirer' })
  acquirer: Acquirer;

  @PrimaryColumn({ type: 'char', length: 3, transformer: currencyTransformer })
  currency: CurrencyCode;

  @PrimaryColumn({ type: 'date' })
  effective_from: IsoDate;

  @Column({ type: 'bigint', transformer: requiredMinorUnitsTransformer })
  fee_minor: number;
}
