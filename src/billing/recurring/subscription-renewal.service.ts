/**
 * SubscriptionRenewalService — L7. Charges a due subscription for its next period. RFC §6.
 *
 *   success  → the period advances (anchor + n intervals), `subscription_renewed`
 *   failure  → `past_due`, retries at +1d/+3d/+7d from the first failure, each failure emailed
 *              (`subscription_payment_failed`) with a fresh hosted `setup` session to fix the card
 *   last retry fails → `canceled`, `subscription_canceled`
 *   `cancel_at_period_end` → `canceled` at the period end, nothing charged
 *
 * Renewals are off-session: no 3-D Secure (an SCA demand is a failure) and no platform risk
 * rules. Every period's attempt goes through ONE intent, tagged with the period it pays for
 * (`metadata.subscription_period_end`): a retry reuses it, a crash between charging and
 * recording is recovered by finding it `succeeded`, and two runners racing on the same period
 * meet at the confirm flow's conditional `→ processing`, which only one of them wins.
 *
 * Everything compares against the injected Clock. A clock that jumps a quarter ahead is caught
 * up period by period in one job run (`MAX_CATCH_UP_PERIODS`), each charged on its own intent.
 */
import { forwardRef, Inject, Injectable } from '@nestjs/common';

import { CheckoutSessionsService } from '../../checkout/checkout-sessions.service';
import type { MerchantScope } from '../../common/base/merchant-scoped.entity';
import { MerchantNotActivatedException } from '../../common/errors/business.exceptions';
import { CardDeclinedException } from '../../common/errors/card.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { TransactionManager } from '../../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../../common/time/clock';
import type { CustomerEntity } from '../../customers/customer.entity';
import { CustomersService } from '../../customers/customers.service';
import { MerchantsService } from '../../merchants/merchants.service';
import type { PaymentMethodEntity } from '../../payment-methods/payment-method.entity';
import { PaymentMethodsService } from '../../payment-methods/payment-methods.service';
import type { PaymentIntentEntity } from '../../payments/payment-intent.entity';
import { PaymentIntentsService } from '../../payments/payment-intents.service';

import { nextPeriod, nextRetryAt } from './billing-period';
import type { PriceEntity } from './price.entity';
import { PriceRepository } from './price.repository';
import { SubscriptionNotices, type NoticeSubject } from './subscription-notices';
import type { SubscriptionEntity } from './subscription.entity';
import { SubscriptionRepository } from './subscription.repository';
import { SubscriptionsService } from './subscriptions.service';

/** Periods one subscription may be charged for in one run, after a clock jump. */
export const MAX_CATCH_UP_PERIODS = 24;

const PAID = new Set(['succeeded', 'requires_capture']);
const REUSABLE = new Set(['requires_payment_method', 'requires_confirmation']);

export type RenewalResult = 'renewed' | 'failed' | 'canceled' | 'skipped';

interface Loaded {
  scope: MerchantScope;
  subscription: SubscriptionEntity;
  customer: CustomerEntity;
  price: PriceEntity;
  merchantName: string;
}

@Injectable()
export class SubscriptionRenewalService {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly subscriptionService: SubscriptionsService,
    private readonly prices: PriceRepository,
    private readonly customers: CustomersService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly paymentIntents: PaymentIntentsService,
    private readonly merchants: MerchantsService,
    private readonly notices: SubscriptionNotices,
    private readonly transactions: TransactionManager,
    @Inject(forwardRef(() => CheckoutSessionsService)) private readonly checkout: CheckoutSessionsService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /** `SubscriptionRenewalJob`'s pass. Each subscription is caught up as far as the clock allows. */
  async renewDue(limit: number): Promise<Record<RenewalResult, number> & { errors: number; seen: number }> {
    const due = await this.subscriptions.findDue(this.clock.now(), limit);
    const counts = { renewed: 0, failed: 0, canceled: 0, skipped: 0, errors: 0, seen: due.length };

    for (const subscription of due) {
      try {
        for (let period = 0; period < MAX_CATCH_UP_PERIODS; period += 1) {
          const result = await this.process(subscription.id, false);
          counts[result] += 1;
          if (result !== 'renewed') break;
        }
      } catch (err) {
        counts.errors += 1;
        this.logger.error('subscription_renewal_failed', err, { subscription_id: subscription.id });
      }
    }
    return counts;
  }

  /**
   * A `setup` session just gave a past-due subscription a new card: charge the overdue period
   * now instead of waiting for the next scheduled retry. A failure here does not consume a retry
   * — the shopper is emailed a fresh link and the schedule stands.
   */
  retryNow(subscriptionId: string): Promise<RenewalResult> {
    return this.process(subscriptionId, true);
  }

  private async process(id: string, forced: boolean): Promise<RenewalResult> {
    const now = this.clock.now();
    const subscription = await this.subscriptions.findOne({ where: { id } });
    if (!subscription || subscription.status === 'canceled') return 'skipped';

    const due =
      subscription.status === 'active'
        ? subscription.currentPeriodEnd.getTime() <= now.getTime()
        : forced || (subscription.nextRetryAt !== null && subscription.nextRetryAt.getTime() <= now.getTime());
    if (!due) return 'skipped';

    if (subscription.status === 'active' && subscription.cancelAtPeriodEnd) {
      await this.transactions.runInTransaction(async (manager) => {
        const locked = await this.subscriptions.lockSubscription(manager, id);
        if (locked && locked.status === 'active') await this.subscriptionService.cancelNow(manager, locked);
      });
      return 'canceled';
    }

    const loaded = await this.load(subscription);
    if (!loaded) return 'skipped';

    const periodKey = subscription.currentPeriodEnd.toISOString();
    let intent = await this.intentForPeriod(loaded, periodKey);

    if (intent && PAID.has(intent.status)) {
      return this.recordSuccess(loaded, intent);
    }
    if (intent?.status === 'processing') {
      // Another runner is mid-confirm on this period; its outcome is recorded by that runner.
      return 'skipped';
    }

    const card = await this.cardFor(loaded);
    if (!card) {
      return this.recordFailure(loaded, intent, forced, 'no usable saved card');
    }

    if (!intent || !REUSABLE.has(intent.status)) {
      try {
        intent = await this.paymentIntents.createInternal(loaded.scope, {
          amount_minor: Number(loaded.price.unitAmountMinor),
          currency: loaded.price.currency,
          payment_method_token: card.vaultToken,
          payment_method_id: card.id,
          customer_id: loaded.customer.id,
          receipt_email: loaded.customer.email,
          subscription_id: subscription.id,
          description: loaded.price.productName,
          metadata: { subscription_id: subscription.id, subscription_period_end: periodKey },
        });
      } catch (err) {
        if (err instanceof MerchantNotActivatedException) {
          // Not the customer's failure: nothing is charged and nothing counts against them.
          this.logger.warn('subscription_renewal_merchant_not_active', { subscription_id: id });
          return 'skipped';
        }
        throw err;
      }
      await this.transactions.runInTransaction((manager) =>
        this.subscriptions.patch(manager, id, { latestPaymentIntentId: intent?.id ?? null }),
      );
    }

    const settled = await this.charge(loaded.scope, intent, card);
    if (PAID.has(settled.status)) {
      return this.recordSuccess(loaded, settled);
    }
    return this.recordFailure(loaded, settled, forced, `payment ${settled.status}`);
  }

  /** One off-session attempt. Never throws for a card outcome; the intent's status is the answer. */
  private async charge(scope: MerchantScope, intent: PaymentIntentEntity, card: PaymentMethodEntity): Promise<PaymentIntentEntity> {
    try {
      await this.paymentIntents.confirmInScope(
        scope,
        intent.id,
        { payment_method_token: card.vaultToken },
        { offSession: true, paymentMethodId: card.id },
      );
    } catch (err) {
      if (!(err instanceof CardDeclinedException)) {
        this.logger.warn('subscription_renewal_charge_error', {
          payment_intent_id: intent.id,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    let after = await this.paymentIntents.requireInScope(scope, intent.id);
    if (after.status === 'requires_action') {
      // Off-session there is nobody to complete a challenge: release it and call it a failure.
      after = await this.paymentIntents.cancelInScope(scope, intent.id, { cancellation_reason: 'abandoned' });
    }
    return after;
  }

  private async recordSuccess(loaded: Loaded, intent: PaymentIntentEntity): Promise<RenewalResult> {
    const recurring = loaded.price.recurring();
    if (!recurring) return 'skipped';
    const periodKey = loaded.subscription.currentPeriodEnd.getTime();

    const renewed = await this.transactions.runInTransaction(async (manager) => {
      const locked = await this.subscriptions.lockSubscription(manager, loaded.subscription.id);
      // Somebody else already advanced (or ended) this period.
      if (!locked || locked.status === 'canceled' || locked.currentPeriodEnd.getTime() !== periodKey) return null;

      const next = nextPeriod(locked.createdAt, locked.currentPeriodEnd, recurring);
      await this.subscriptions.patch(manager, locked.id, {
        status: 'active',
        currentPeriodStart: next.start,
        currentPeriodEnd: next.end,
        latestPaymentIntentId: intent.id,
        failedAttempts: 0,
        pastDueSince: null,
        nextRetryAt: null,
      });
      Object.assign(locked, {
        status: 'active',
        currentPeriodStart: next.start,
        currentPeriodEnd: next.end,
        latestPaymentIntentId: intent.id,
        failedAttempts: 0,
        pastDueSince: null,
        nextRetryAt: null,
      });
      await this.notices.renewed(manager, { ...this.subject(loaded), subscription: locked });
      return locked;
    });
    if (!renewed) return 'skipped';

    loaded.subscription.currentPeriodEnd = renewed.currentPeriodEnd;
    this.logger.info('subscription_renewed', {
      subscription_id: renewed.id,
      payment_intent_id: intent.id,
      current_period_end: renewed.currentPeriodEnd.toISOString(),
    });
    return 'renewed';
  }

  private async recordFailure(
    loaded: Loaded,
    intent: PaymentIntentEntity | null,
    forced: boolean,
    reason: string,
  ): Promise<RenewalResult> {
    const now = this.clock.now();
    const before = loaded.subscription;
    const failedAttempts = forced ? before.failedAttempts : before.failedAttempts + 1;
    const pastDueSince = before.pastDueSince ?? now;
    const retryAt = forced ? before.nextRetryAt : nextRetryAt(pastDueSince, failedAttempts);
    const cancel = !forced && retryAt === null;

    // A fresh link for every failure email. Built before the commit: an orphaned setup session
    // (the commit below lost a race) expires on its own and charges nothing.
    const updateUrl = cancel ? null : await this.checkout.createRenewalSetupSession(before, loaded.customer, loaded.price);

    const result = await this.transactions.runInTransaction(async (manager): Promise<RenewalResult> => {
      const locked = await this.subscriptions.lockSubscription(manager, before.id);
      if (
        !locked ||
        locked.status === 'canceled' ||
        locked.failedAttempts !== before.failedAttempts ||
        locked.currentPeriodEnd.getTime() !== before.currentPeriodEnd.getTime()
      ) {
        return 'skipped';
      }

      await this.subscriptions.patch(manager, locked.id, {
        status: cancel ? locked.status : 'past_due',
        failedAttempts,
        pastDueSince,
        nextRetryAt: retryAt,
        latestPaymentIntentId: intent?.id ?? locked.latestPaymentIntentId,
      });
      Object.assign(locked, { status: cancel ? locked.status : 'past_due', failedAttempts, pastDueSince, nextRetryAt: retryAt });

      if (cancel) {
        await this.subscriptionService.cancelNow(manager, locked);
        return 'canceled';
      }
      await this.notices.paymentFailed(manager, { ...this.subject(loaded), subscription: locked }, updateUrl ?? '', retryAt);
      return 'failed';
    });

    this.logger.warn('subscription_renewal_failed_attempt', {
      subscription_id: before.id,
      payment_intent_id: intent?.id ?? null,
      failed_attempts: failedAttempts,
      next_retry_at: retryAt ? retryAt.toISOString() : null,
      outcome: result,
      forced,
      reason,
    });
    return result;
  }

  private async load(subscription: SubscriptionEntity): Promise<Loaded | null> {
    const scope = { merchantId: subscription.merchantId, livemode: subscription.livemode };
    const price = await this.prices.findById(subscription.priceId);
    if (!price) {
      this.logger.error('subscription_price_missing', undefined, { subscription_id: subscription.id });
      return null;
    }
    const [customer, merchant] = await Promise.all([
      this.customers.requireInScope(scope, subscription.customerId),
      this.merchants.getById(subscription.merchantId),
    ]);
    return { scope, subscription, customer, price, merchantName: merchant.displayName };
  }

  /** The intent already charging this period, if the latest one is it. */
  private async intentForPeriod(loaded: Loaded, periodKey: string): Promise<PaymentIntentEntity | null> {
    const latestId = loaded.subscription.latestPaymentIntentId;
    if (!latestId) return null;
    const intent = await this.paymentIntents.requireInScope(loaded.scope, latestId);
    return intent.metadata.subscription_period_end === periodKey ? intent : null;
  }

  /** The subscription's card, else the customer's default. Detached cards are not usable. */
  private async cardFor(loaded: Loaded): Promise<PaymentMethodEntity | null> {
    const candidates = [loaded.subscription.defaultPaymentMethodId, loaded.customer.defaultPaymentMethodId];
    for (const id of candidates) {
      if (!id) continue;
      const card = await this.paymentMethods.findUsable(loaded.scope, id);
      if (card && card.customerId === loaded.customer.id) return card;
    }
    return null;
  }

  private subject(loaded: Loaded): NoticeSubject {
    return {
      subscription: loaded.subscription,
      customer: loaded.customer,
      price: loaded.price,
      merchantName: loaded.merchantName,
    };
  }
}
