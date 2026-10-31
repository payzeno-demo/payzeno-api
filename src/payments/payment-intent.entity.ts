/**
 * `payment_intent` — data-model.md §1.5.
 *
 * `id`, `merchant_id`, `livemode`, `created_at` and `updated_at` come from
 * `MerchantScopedEntity`; they are declared in exactly one place (domain-model §11.5).
 * `synchronize` is off everywhere: the schema is what `src/migrations/` says it is.
 */

import type {
  CancellationReason,
  CaptureMethod,
  ChargeId,
  CurrencyCode,
  CustomerId,
  Metadata,
  NextAction,
  PaymentIntentStatus,
  PaymentMethodId,
  PaymentMethodToken,
  Presentment,
  ReviewId,
  SubscriptionId,
} from '@payzeno/contracts';
import { Column, Entity, Index, OneToMany } from 'typeorm';

import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { currencyTransformer, requiredMinorUnitsTransformer } from '../common/typeorm/minor-units.transformer';

import { ChargeEntity } from './charge.entity';

@Entity({ name: 'payment_intent' })
@Index('ix_payment_intent_merchant_created', ['merchantId', 'createdAt'])
@Index('ix_payment_intent_status', ['status'])
@Index('ix_payment_intent_customer_reference', ['merchantId', 'customer_reference'])
export class PaymentIntentEntity extends MerchantScopedEntity {
  @Column({ type: 'bigint', name: 'amount_minor', transformer: requiredMinorUnitsTransformer })
  amount_minor: number;

  @Column({ type: 'char', length: 3, transformer: currencyTransformer })
  currency: CurrencyCode;

  @Column({ type: 'enum', enum: [
    'requires_payment_method',
    'requires_confirmation',
    'processing',
    'requires_action',
    'requires_capture',
    'succeeded',
    'failed',
    'canceled',
  ], enumName: 'payment_intent_status' })
  status: PaymentIntentStatus;

  @Column({ type: 'enum', enum: ['automatic', 'manual'], enumName: 'capture_method', default: 'automatic' })
  capture_method: CaptureMethod;

  /** `pmt_` vault token. Never a PAN — arc PCI, migration 10 dropped the last two PAN columns. */
  @Column({ type: 'text', nullable: true })
  payment_method_token: PaymentMethodToken | null;

  @Column({ type: 'text', nullable: true })
  customer_reference: string | null;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 22, nullable: true })
  statement_descriptor: string | null;

  /** No FK: the charge references the intent, not the reverse (data-model §1.5). */
  @Column({ type: 'text', nullable: true })
  latest_charge_id: ChargeId | null;

  @Column({ type: 'text' })
  client_secret: string;

  /** Migration 28. Set exactly when `status === 'requires_action'`. */
  @Column({ type: 'jsonb', nullable: true })
  next_action: NextAction | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata: Metadata;

  @Column({ type: 'timestamptz', nullable: true })
  canceled_at: Date | null;

  @Column({
    type: 'enum',
    enum: ['requested_by_customer', 'duplicate', 'fraudulent', 'abandoned', 'expired'],
    enumName: 'cancellation_reason',
    nullable: true,
  })
  cancellation_reason: CancellationReason | null;

  // -- RFC platform-v2 (migration platform-v2 money 4) -------------------------------------

  /** §5. The customer this payment belongs to, when it has one. */
  @Column({ type: 'text', nullable: true })
  customer_id: CustomerId | null;

  /** §5. The saved card this payment used — the token above is that card's vault token. */
  @Column({ type: 'text', nullable: true })
  payment_method_id: PaymentMethodId | null;

  /** Where the `receipt` email goes once the payment is captured. */
  @Column({ type: 'text', nullable: true })
  receipt_email: string | null;

  /** §7. Set when the shopper pays in another currency: `amount_minor`/`currency` are then the converted price. */
  @Column({ type: 'jsonb', nullable: true })
  presentment: Presentment | null;

  /** §8. The risk review that held this payment, open or closed. */
  @Column({ type: 'text', nullable: true })
  review_id: ReviewId | null;

  /** §6. Set on every payment a subscription takes, the first and each renewal. */
  @Column({ type: 'text', nullable: true })
  subscription_id: SubscriptionId | null;

  @OneToMany(() => ChargeEntity, (charge) => charge.payment_intent)
  charges?: ChargeEntity[];

  /** Terminal intents are immutable except for `metadata` (domain-model §2). */
  isTerminal(): boolean {
    return this.status === 'succeeded' || this.status === 'failed' || this.status === 'canceled';
  }
}
