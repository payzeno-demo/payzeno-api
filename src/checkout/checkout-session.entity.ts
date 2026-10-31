/**
 * `checkout_session` — migration 33.
 *
 * A session is presentation and routing around exactly one PaymentIntent: what the shopper was
 * shown (amount, line items, merchant), where to send them afterwards, and the credential their
 * browser holds. Money state lives on the intent; `status` here is reconciled from it
 * (`CheckoutSessionsService`), never driven independently.
 */
import type {
  CheckoutLineItem,
  CheckoutMode,
  CheckoutSessionStatus,
  CheckoutUiMode,
  CurrencyCode,
  CustomerId,
  Metadata,
  PaymentIntentId,
  PriceId,
  SavePaymentMethodOption,
  SubscriptionId,
} from '@payzeno/contracts';
import { Column, Entity, Index } from 'typeorm';


import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { currencyTransformer, requiredMinorUnitsTransformer } from '../common/typeorm/minor-units.transformer';

/** How long a shopper has to pay before the session expires and its intent is cancelled. */
export const CHECKOUT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

@Entity({ name: 'checkout_session' })
@Index('ix_checkout_session_merchant_created', ['merchantId', 'createdAt'])
export class CheckoutSessionEntity extends MerchantScopedEntity {
  @Column({ type: 'text', name: 'payment_intent_id' })
  paymentIntentId!: PaymentIntentId;

  @Column({ type: 'enum', enum: ['open', 'complete', 'expired'], enumName: 'checkout_session_status' })
  status!: CheckoutSessionStatus;

  @Column({ type: 'enum', enum: ['hosted', 'embedded'], enumName: 'checkout_ui_mode', name: 'ui_mode' })
  uiMode!: CheckoutUiMode;

  @Column({ type: 'bigint', name: 'amount_minor', transformer: requiredMinorUnitsTransformer })
  amountMinor!: number;

  @Column({ type: 'char', length: 3, transformer: currencyTransformer })
  currency!: CurrencyCode;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Display only — the session amount is authoritative (it is what the intent charges). */
  @Column({ type: 'jsonb', name: 'line_items', default: () => "'[]'::jsonb" })
  lineItems!: CheckoutLineItem[];

  @Column({ type: 'text', name: 'customer_reference', nullable: true })
  customerReference!: string | null;

  @Column({ type: 'text', name: 'customer_email', nullable: true })
  customerEmail!: string | null;

  @Column({ type: 'text', name: 'success_url', nullable: true })
  successUrl!: string | null;

  @Column({ type: 'text', name: 'cancel_url', nullable: true })
  cancelUrl!: string | null;

  @Column({ type: 'text', name: 'allowed_origin', nullable: true })
  allowedOrigin!: string | null;

  /** `cs_<ULID>_secret_<32 hex>`. Stored and looked up like `payment_intent.client_secret`. */
  @Column({ type: 'text', name: 'client_secret' })
  clientSecret!: string;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Metadata;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', name: 'completed_at', nullable: true })
  completedAt!: Date | null;

  // -- RFC platform-v2 (migration platform-v2 money 4) ---------------------------------------

  /** `payment` charges once; `subscription` charges the first period; `setup` saves a card. */
  @Column({ type: 'enum', enum: ['payment', 'subscription', 'setup'], enumName: 'checkout_mode', default: 'payment' })
  mode!: CheckoutMode;

  @Column({ type: 'text', name: 'customer_id', nullable: true })
  customerId!: CustomerId | null;

  /** `subscription` mode: the recurring price the first payment is for. */
  @Column({ type: 'text', name: 'price_id', nullable: true })
  priceId!: PriceId | null;

  /** The subscription a `subscription` session started, or the one a `setup` session repairs. */
  @Column({ type: 'text', name: 'subscription_id', nullable: true })
  subscriptionId!: SubscriptionId | null;

  /** `payment` mode only: whether the page offers "save card for next time". */
  @Column({ type: 'text', name: 'save_payment_method', default: 'never' })
  savePaymentMethod!: SavePaymentMethodOption;

  @Column({ type: 'boolean', name: 'adaptive_pricing', default: true })
  adaptivePricing!: boolean;

  /**
   * The shopper ticked "save card" on the confirm that paid. Kept on the row because a 3-D
   * Secure payment completes on a later request that carries no such flag.
   */
  @Column({ type: 'boolean', name: 'save_card_requested', default: false })
  saveCardRequested!: boolean;
}
