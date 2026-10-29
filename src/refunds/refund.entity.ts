/**
 * `refund` — data-model.md §1.7.
 *
 * A refund is only ever created against a `captured` or `settled` charge. The uncaptured case
 * is an authorisation reversal and takes `POST /v1/payment_intents/:id/cancel` instead — it
 * has different network semantics, recovers interchange, and produces no cardholder-visible
 * credit line, so it produces no row here at all (domain-model §4).
 */

import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import type {
  ChargeId,
  CurrencyCode,
  Metadata,
  RefundReason,
  RefundStatus,
} from '@payzeno/contracts';

import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { currencyTransformer, requiredMinorUnitsTransformer } from '../common/typeorm/minor-units.transformer';
import { ChargeEntity } from '../payments/charge.entity';

@Entity({ name: 'refund' })
@Index('ix_refund_charge_id', ['charge_id'])
@Index('ix_refund_merchant_created', ['merchantId', 'createdAt'])
@Index('uq_refund_processor_reference', ['processor_reference'], {
  unique: true,
  where: 'processor_reference IS NOT NULL',
})
export class RefundEntity extends MerchantScopedEntity {
  @Column({ type: 'text' })
  charge_id: ChargeId;

  @ManyToOne(() => ChargeEntity)
  @JoinColumn({ name: 'charge_id' })
  charge?: ChargeEntity;

  @Column({ type: 'bigint', transformer: requiredMinorUnitsTransformer })
  amount_minor: number;

  @Column({ type: 'char', length: 3, transformer: currencyTransformer })
  currency: CurrencyCode;

  @Column({
    type: 'enum',
    enum: ['pending', 'succeeded', 'failed', 'canceled'],
    enumName: 'refund_status',
  })
  status: RefundStatus;

  @Column({
    type: 'enum',
    enum: ['duplicate', 'fraudulent', 'requested_by_customer', 'expired_uncaptured_auth'],
    enumName: 'refund_reason',
  })
  reason: RefundReason;

  @Column({ type: 'text', nullable: true })
  failure_reason: string | null;

  /** The acquirer's id for the credit. Unique — a retry is a new row, never a resubmission. */
  @Column({ type: 'text', nullable: true })
  processor_reference: string | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Metadata;

  @Column({ type: 'timestamptz', nullable: true })
  succeeded_at: Date | null;

  isTerminal(): boolean {
    return this.status !== 'pending';
  }

  /**
   * True when the refund lands in the same acquirer settlement file as the original capture,
   * i.e. the charge had not settled when we submitted it. The ledger needs this on
   * `refund.created` to decide whether to net the refund into the open batch or post it
   * against the merchant's next payout (domain-model §4).
   */
  netsAgainstSettlement(chargeStatus: string): boolean {
    return chargeStatus === 'captured';
  }
}
