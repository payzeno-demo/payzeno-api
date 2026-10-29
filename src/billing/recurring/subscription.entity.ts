/**
 * `customer_subscription` — a merchant charging one of *their* customers every period.
 * RFC platform-v2 §6, migration platform-v2 money 2.
 *
 * `csub_`, never `sub_`: billing-legacy's subscriptions are how Payzeno bills merchants, and
 * the two must not be confusable in a log line or a query.
 *
 *   active ──renewal fails──▶ past_due ──retry/setup succeeds──▶ active
 *     │                          └──last retry fails──▶ canceled
 *     └──cancel (now, or at period end)──────────────▶ canceled
 *
 * The billing anchor is `created_at` (= the first period's start): every period end is
 * anchor + n intervals, see `billing-period.ts`.
 */
import type {
  CustomerId,
  Metadata,
  PaymentIntentId,
  PaymentMethodId,
  PriceId,
  Subscription,
  SubscriptionStatus,
} from '@payzeno/contracts';
import { Column, Entity, Index } from 'typeorm';

import { MerchantScopedEntity } from '../../common/base/merchant-scoped.entity';

/** `csub_`. Minted through `IdFactory.opaque` until the prefix joins `API_ID_PREFIXES`. */
export const SUBSCRIPTION_ID_PREFIX = 'csub_';

@Entity({ name: 'customer_subscription' })
@Index('ix_customer_subscription_merchant_created', ['merchantId', 'livemode', 'createdAt'])
export class SubscriptionEntity extends MerchantScopedEntity {
  @Column({ type: 'text', name: 'customer_id' })
  customerId!: CustomerId;

  @Column({ type: 'text', name: 'price_id' })
  priceId!: PriceId;

  @Column({ type: 'text' })
  status!: SubscriptionStatus;

  @Column({ type: 'timestamptz', name: 'current_period_start' })
  currentPeriodStart!: Date;

  @Column({ type: 'timestamptz', name: 'current_period_end' })
  currentPeriodEnd!: Date;

  @Column({ type: 'boolean', name: 'cancel_at_period_end', default: false })
  cancelAtPeriodEnd!: boolean;

  @Column({ type: 'timestamptz', name: 'canceled_at', nullable: true })
  canceledAt!: Date | null;

  @Column({ type: 'text', name: 'default_payment_method_id', nullable: true })
  defaultPaymentMethodId!: PaymentMethodId | null;

  @Column({ type: 'text', name: 'latest_payment_intent_id', nullable: true })
  latestPaymentIntentId!: PaymentIntentId | null;

  @Column({ type: 'timestamptz', name: 'next_retry_at', nullable: true })
  nextRetryAt!: Date | null;

  @Column({ type: 'smallint', name: 'failed_attempts', default: 0 })
  failedAttempts!: number;

  /** When the current run of failures began. The +1d/+3d/+7d retries count from here. */
  @Column({ type: 'timestamptz', name: 'past_due_since', nullable: true })
  pastDueSince!: Date | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Metadata;
}

export function toSubscription(row: SubscriptionEntity): Subscription {
  return {
    id: row.id,
    object: 'subscription',
    merchant_id: row.merchantId,
    customer_id: row.customerId,
    price_id: row.priceId,
    status: row.status,
    current_period_start: row.currentPeriodStart.toISOString(),
    current_period_end: row.currentPeriodEnd.toISOString(),
    cancel_at_period_end: row.cancelAtPeriodEnd,
    canceled_at: row.canceledAt ? row.canceledAt.toISOString() : null,
    default_payment_method_id: row.defaultPaymentMethodId,
    latest_payment_intent_id: row.latestPaymentIntentId,
    next_retry_at: row.nextRetryAt ? row.nextRetryAt.toISOString() : null,
    failed_attempts: row.failedAttempts,
    livemode: row.livemode,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
  };
}
