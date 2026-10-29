/**
 * `charge` — data-model.md §1.6.
 *
 * The table flattens `CardSummary` into six `card_*` columns; every API, event and console
 * surface uses the nested object. `toCardSummary()` is the one place that mapping happens —
 * three names for one concept across three files is how a console renders `undefined`.
 *
 * arc PCI: `pan_first_six` and `pan_encrypted` were dropped by migration 10 and must not come
 * back. arc INC: `uq_charge_processor_reference` (migration 16) was added by dhotfix during
 * the incident; it guards payzeno-api against double-authorising and it is explicitly NOT a
 * defence against the ledger's double capture (data-model §1.6).
 */

import type {
  Acquirer,
  CaptureMethod,
  CardBrand,
  CardFunding,
  CardSummary,
  ChargeStatus,
  CurrencyCode,
  DeclineCode,
  Metadata,
  PaymentIntentId,
  RiskOutcome,
  ScaExemption,
  SettlementBatchId,
  ThreeDSecureResult,
} from '@payzeno/contracts';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { currencyTransformer, requiredMinorUnitsTransformer, trimmedCharTransformer } from '../common/typeorm/minor-units.transformer';

import { PaymentIntentEntity } from './payment-intent.entity';

@Entity({ name: 'charge' })
@Index('ix_charge_merchant_created', ['merchantId', 'createdAt'])
@Index('ix_charge_payment_intent_id', ['payment_intent_id'])
@Index('ix_charge_status', ['status'])
@Index('uq_charge_processor_reference', ['acquirer', 'processor_reference'], {
  unique: true,
  where: 'processor_reference IS NOT NULL',
})
@Index('ix_charge_authorization_expires', ['authorization_expires_at'], {
  where: "status = 'authorized'",
})
@Index('pix_charge_unsettled', ['settlement_batch_id'], {
  where: "settlement_batch_id IS NULL AND status = 'captured'",
})
export class ChargeEntity extends MerchantScopedEntity {
  @Column({ type: 'text' })
  payment_intent_id: PaymentIntentId;

  @ManyToOne(() => PaymentIntentEntity, (intent) => intent.charges)
  @JoinColumn({ name: 'payment_intent_id' })
  payment_intent?: PaymentIntentEntity;

  @Column({ type: 'bigint', transformer: requiredMinorUnitsTransformer })
  amount_minor: number;

  @Column({ type: 'bigint', default: 0, transformer: requiredMinorUnitsTransformer })
  captured_amount_minor: number;

  @Column({ type: 'bigint', default: 0, transformer: requiredMinorUnitsTransformer })
  refunded_amount_minor: number;

  @Column({ type: 'char', length: 3, transformer: currencyTransformer })
  currency: CurrencyCode;

  @Column({
    type: 'enum',
    enum: ['pending', 'authorized', 'captured', 'settled', 'failed', 'voided', 'expired', 'reversed'],
    enumName: 'charge_status',
  })
  status: ChargeStatus;

  @Column({ type: 'enum', enum: ['visa', 'mastercard', 'amex', 'discover'], enumName: 'card_brand' })
  card_brand: CardBrand;

  @Column({ type: 'char', length: 4 })
  card_last_four: string;

  @Column({ type: 'smallint' })
  card_exp_month: number;

  @Column({ type: 'smallint' })
  card_exp_year: number;

  @Column({ type: 'char', length: 2, nullable: true, transformer: trimmedCharTransformer })
  card_country: string | null;

  @Column({
    type: 'enum',
    enum: ['credit', 'debit', 'prepaid', 'unknown'],
    enumName: 'card_funding',
    default: 'unknown',
  })
  card_funding: CardFunding;

  @Column({ type: 'enum', enum: ['worldflow', 'nordpay'], enumName: 'acquirer' })
  acquirer: Acquirer;

  @Column({ type: 'text', nullable: true })
  network_transaction_id: string | null;

  @Column({ type: 'text', nullable: true })
  processor_reference: string | null;

  @Column({ type: 'varchar', length: 6, nullable: true })
  authorization_code: string | null;

  @Column({ type: 'enum', enum: ['automatic', 'manual'], enumName: 'capture_method' })
  capture_method: CaptureMethod;

  @Column({ type: 'smallint', default: 0 })
  risk_score: number;

  @Column({ type: 'enum', enumName: 'decline_code', nullable: true, enum: [
    'do_not_honor',
    'insufficient_funds',
    'lost_card',
    'stolen_card',
    'expired_card',
    'incorrect_cvc',
    'processing_error',
    'issuer_unavailable',
    'velocity_exceeded',
    'fraud_suspected',
  ] })
  failure_code: DeclineCode | null;

  @Column({ type: 'text', nullable: true })
  failure_message: string | null;

  /** Migration 28. */
  @Column({ type: 'jsonb', nullable: true })
  three_d_secure: ThreeDSecureResult | null;

  @Column({
    type: 'enum',
    enum: ['low_value', 'tra', 'moto', 'recurring'],
    enumName: 'sca_exemption',
    nullable: true,
  })
  sca_exemption: ScaExemption | null;

  /** The ledger's id. No FK — different database (migration 12). */
  @Column({ type: 'text', nullable: true })
  settlement_batch_id: SettlementBatchId | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Metadata;

  @Column({ type: 'timestamptz', nullable: true })
  authorized_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  captured_at: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  settled_at: Date | null;

  /** `authorized_at + 7d`, or `+ 30d` for MCCs 3000-3999 / 7011 / 7512. See ChargeExpiryPolicy. */
  @Column({ type: 'timestamptz', nullable: true })
  authorization_expires_at: Date | null;

  // -- RFC platform-v2 §8 risk signals (migration platform-v2 money 4) -------------------------

  /** The vault's keyed card hash. Card velocity is a query over this; never logged with a merchant id. */
  @Column({ type: 'text', nullable: true })
  card_fingerprint: string | null;

  /** First `X-Forwarded-For` hop of a checkout confirm. Distinct-cards-per-address velocity. */
  @Column({ type: 'text', nullable: true })
  shopper_ip: string | null;

  /** The edge's view of the shopper's country at confirm time. */
  @Column({ type: 'char', length: 2, nullable: true, transformer: trimmedCharTransformer })
  shopper_country: string | null;

  /** What the platform rules decided for this authorisation. Null for charges before §8. */
  @Column({ type: 'text', nullable: true })
  risk_outcome: RiskOutcome | null;

  /** The one place the six flat `card_*` columns become the contracted nested object. */
  toCardSummary(): CardSummary {
    return {
      brand: this.card_brand,
      last_four: this.card_last_four,
      exp_month: this.card_exp_month,
      exp_year: this.card_exp_year,
      country: this.card_country,
      funding: this.card_funding,
    };
  }

  /** How much of this charge may still be refunded. Enforced under a row lock by RefundPolicyService. */
  get refundableAmountMinor(): number {
    return Math.max(0, Number(this.captured_amount_minor) - Number(this.refunded_amount_minor));
  }

  /** Derived, never stored — domain-model §3 is explicit that there is no `refunded` status. */
  get refundState(): 'none' | 'partial' | 'full' {
    const refunded = Number(this.refunded_amount_minor);
    const captured = Number(this.captured_amount_minor);
    if (refunded <= 0) {
      return 'none';
    }
    return refunded >= captured ? 'full' : 'partial';
  }
}
