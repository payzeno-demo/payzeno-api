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

import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
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
  ScaExemption,
  SettlementBatchId,
  ThreeDSecureResult,
} from '@payzeno/contracts';

import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { currencyTransformer, requiredMinorUnitsTransformer, trimmedCharTransformer } from '../common/typeorm/minor-units.transformer';
import { PaymentIntentEntity } from './payment-intent.entity';

@Entity({ name: 'charge' })
@Index('ix_charge_merchant_created', ['merchant_id', 'created_at'])
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
  @Column({ type: 'bigint', default: 0, transformer: requiredMinorUnitsTransformer })
  captured_amount_minor: number;

  @Column({ type: 'char', length: 3, transformer: currencyTransformer })
  currency: CurrencyCode;

  @Column({ type: 'char', length: 4 })
  card_last_four: string;

  @Column({ type: 'char', length: 2, nullable: true, transformer: trimmedCharTransformer })
  card_country: string | null;

  @Column({ type: 'enum', enum: ['worldflow', 'nordpay'], enumName: 'acquirer' })
  acquirer: Acquirer;

  @Column({ type: 'text', nullable: true })
  network_transaction_id: string | null;

  @Column({ type: 'text', nullable: true })
  processor_reference: string | null;

  @Column({ type: 'text', nullable: true })
  failure_message: string | null;

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

  @Column({ type: 'timestamptz', nullable: true })
  captured_at: Date | null;

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
