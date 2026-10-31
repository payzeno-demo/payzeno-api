/**
 * SubscriptionsService — L7. A merchant billing one of their customers every period.
 * RFC platform-v2 §6.
 *
 * Two ways in: checkout `mode: 'subscription'` (`startFromCheckout`, inside the commit that
 * completes the session) and `POST /v1/subscriptions` for a customer who already has a saved
 * card (`create`, which charges the first period off-session before the subscription exists —
 * a declined first payment is a 402 and no subscription, never a subscription that was never
 * paid for). Renewals are `SubscriptionRenewalService`'s.
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthPrincipal,
  Paginated,
  PaymentMethodId,
  Subscription,
  SubscriptionId,
  SubscriptionListQuery,
  SubscriptionStatus,
} from '@payzeno/contracts';
import { SUBSCRIPTION_STATUSES } from '@payzeno/contracts';
import type { EntityManager } from 'typeorm';

import { livemodeOf, merchantIdOf } from '../../auth/principal/principal.factory';
import { BaseService } from '../../common/base/base.service';
import type { MerchantScope } from '../../common/base/merchant-scoped.entity';
import { ValidationException } from '../../common/errors/api.exception';
import { CardDeclinedException } from '../../common/errors/card.exceptions';
import { ResourceNotFoundException } from '../../common/errors/not-found.exceptions';
import { IdFactory } from '../../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { resolveListQuery } from '../../common/pagination/list-query.dto';
import { TransactionManager } from '../../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../../common/time/clock';
import type { CustomerEntity } from '../../customers/customer.entity';
import { CustomersService } from '../../customers/customers.service';
import { MerchantsService } from '../../merchants/merchants.service';
import type { PaymentMethodEntity } from '../../payment-methods/payment-method.entity';
import { PaymentMethodsService } from '../../payment-methods/payment-methods.service';
import type { PaymentIntentEntity } from '../../payments/payment-intent.entity';
import { PaymentIntentRepository } from '../../payments/payment-intent.repository';
import { PaymentIntentsService } from '../../payments/payment-intents.service';

import { addIntervals } from './billing-period';
import type { CancelSubscriptionDto, CreateSubscriptionDto } from './dto/price.dto';
import type { PriceEntity } from './price.entity';
import { PriceRepository } from './price.repository';
import { PricesService } from './prices.service';
import { SubscriptionNotices } from './subscription-notices';
import { SUBSCRIPTION_ID_PREFIX, SubscriptionEntity, toSubscription } from './subscription.entity';
import { SubscriptionRepository } from './subscription.repository';

/** An intent that has the money: paid, or (under a §8 review) authorised and held. */
const PAID = new Set(['succeeded', 'requires_capture']);

export interface CheckoutStart {
  scope: MerchantScope;
  customer: CustomerEntity;
  price: PriceEntity;
  paymentMethod: PaymentMethodEntity;
  intent: PaymentIntentEntity;
  merchantName: string;
}

@Injectable()
export class SubscriptionsService extends BaseService<SubscriptionEntity> {
  constructor(
    private readonly subscriptions: SubscriptionRepository,
    private readonly prices: PricesService,
    private readonly priceRows: PriceRepository,
    private readonly customers: CustomersService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly paymentIntents: PaymentIntentsService,
    private readonly intents: PaymentIntentRepository,
    private readonly merchants: MerchantsService,
    private readonly notices: SubscriptionNotices,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(subscriptions, logger);
  }

  get entityName(): string {
    return 'subscription';
  }

  /** `POST /v1/subscriptions`: charge the first period on the saved card, then start. */
  async create(principal: AuthPrincipal, dto: CreateSubscriptionDto): Promise<Subscription> {
    const scope = scopeFrom(principal);
    await this.paymentIntents.assertMayChargeLive(scope);

    const customer = await this.customers.requireInScope(scope, dto.customer_id);
    const price = await this.prices.requireRecurring(scope, dto.price_id);
    const paymentMethodId = dto.payment_method_id ?? customer.defaultPaymentMethodId;
    if (!paymentMethodId) {
      throw new ValidationException('This customer has no saved card to charge', [
        { path: 'payment_method_id', code: 'required', message: 'save a card with a checkout session first' },
      ]);
    }
    const card = await this.paymentMethods.getUsable(scope, customer.id, paymentMethodId);

    const intent = await this.paymentIntents.createInternal(scope, {
      amount_minor: Number(price.unitAmountMinor),
      currency: price.currency,
      payment_method_token: card.vaultToken,
      payment_method_id: card.id,
      customer_id: customer.id,
      receipt_email: customer.email,
      description: price.productName,
      metadata: dto.metadata ?? {},
    });
    const paid = await this.paymentIntents.confirmInScope(
      scope,
      intent.id,
      { payment_method_token: card.vaultToken },
      { offSession: true, paymentMethodId: card.id },
    );
    if (!PAID.has(paid.status)) {
      // Off-session there is no shopper to authenticate; an SCA demand is a failed first payment.
      if (!paid.isTerminal()) {
        await this.paymentIntents.cancelInScope(scope, paid.id, { cancellation_reason: 'abandoned' });
      }
      throw new CardDeclinedException('do_not_honor', 'The first payment of the subscription did not succeed');
    }

    const merchant = await this.merchants.getById(scope.merchantId);
    const row = await this.transactions.runInTransaction((manager) =>
      this.start(manager, {
        scope,
        customer,
        price,
        paymentMethod: card,
        intent: paid,
        merchantName: merchant.displayName,
      }, dto.metadata ?? {}),
    );
    return toSubscription(row);
  }

  /** Checkout `mode: 'subscription'`, inside the transaction that completes the session. */
  startFromCheckout(manager: EntityManager, start: CheckoutStart): Promise<SubscriptionEntity> {
    return this.start(manager, start, {});
  }

  private async start(manager: EntityManager, start: CheckoutStart, metadata: Record<string, string>): Promise<SubscriptionEntity> {
    const recurring = start.price.recurring();
    if (!recurring) {
      throw new ValidationException('A subscription needs a recurring price', [
        { path: 'price_id', code: 'not_recurring', message: start.price.id },
      ]);
    }

    const now = this.clock.now();
    const row = new SubscriptionEntity();
    row.id = this.ids.opaque(SUBSCRIPTION_ID_PREFIX);
    row.merchantId = start.scope.merchantId;
    row.livemode = start.scope.livemode;
    row.customerId = start.customer.id;
    row.priceId = start.price.id;
    row.status = 'active';
    // `created_at` is the billing anchor; the first period starts on the same instant.
    row.currentPeriodStart = now;
    row.currentPeriodEnd = addIntervals(now, recurring, 1);
    row.cancelAtPeriodEnd = false;
    row.canceledAt = null;
    row.defaultPaymentMethodId = start.paymentMethod.id;
    row.latestPaymentIntentId = start.intent.id;
    row.nextRetryAt = null;
    row.failedAttempts = 0;
    row.pastDueSince = null;
    row.metadata = metadata;
    row.createdAt = now;
    row.updatedAt = now;

    await this.subscriptions.insertSubscription(manager, row);
    await this.intents.linkBilling(manager, start.intent.id, { subscription_id: row.id });
    await this.notices.started(manager, {
      subscription: row,
      customer: start.customer,
      price: start.price,
      merchantName: start.merchantName,
    });

    this.logger.info('subscription_started', {
      subscription_id: row.id,
      merchant_id: row.merchantId,
      customer_id: row.customerId,
      price_id: row.priceId,
      current_period_end: row.currentPeriodEnd.toISOString(),
    });
    return row;
  }

  async get(principal: AuthPrincipal, id: SubscriptionId): Promise<Subscription> {
    return toSubscription(await this.findOneOrThrow(id, scopeFrom(principal)));
  }

  requireInScope(scope: MerchantScope, id: SubscriptionId): Promise<SubscriptionEntity> {
    return this.findOneOrThrow(id, scope);
  }

  async list(principal: AuthPrincipal, query: SubscriptionListQuery): Promise<Paginated<Subscription>> {
    const status = query.status;
    if (status !== undefined && !isSubscriptionStatus(status)) {
      throw new ValidationException('Unknown subscription status', [
        { path: 'status', code: 'invalid_value', message: SUBSCRIPTION_STATUSES.join(', ') },
      ]);
    }
    const page = await this.subscriptions.listScoped(scopeFrom(principal), resolveListQuery(query), {
      customerId: query.customer_id,
      status,
    });
    return { ...page, data: page.data.map(toSubscription) };
  }

  /**
   * `POST /v1/subscriptions/:id/cancel`. At period end (the default) an active subscription
   * keeps what it paid for and the renewal job ends it; otherwise — or when it is past due, whose
   * period is already over — it ends now. Cancelling a cancelled subscription is a no-op.
   */
  async cancel(principal: AuthPrincipal, id: SubscriptionId, dto: CancelSubscriptionDto): Promise<Subscription> {
    const scope = scopeFrom(principal);
    await this.findOneOrThrow(id, scope);
    const atPeriodEnd = dto.at_period_end ?? true;

    const row = await this.transactions.runInTransaction(async (manager) => {
      const locked = await this.subscriptions.lockSubscription(manager, id);
      if (!locked || locked.status === 'canceled') return locked;

      if (atPeriodEnd && locked.status === 'active') {
        await this.subscriptions.patch(manager, id, { cancelAtPeriodEnd: true });
        locked.cancelAtPeriodEnd = true;
        return locked;
      }

      await this.cancelNow(manager, locked);
      return locked;
    });
    if (!row) throw new ResourceNotFoundException('subscription', id);

    this.logger.info('subscription_cancel_requested', { subscription_id: id, at_period_end: atPeriodEnd, status: row.status });
    return toSubscription(row);
  }

  /** Ends a locked subscription now and tells the customer. Shared with the renewal job. */
  async cancelNow(manager: EntityManager, locked: SubscriptionEntity): Promise<void> {
    const now = this.clock.now();
    await this.subscriptions.patch(manager, locked.id, { status: 'canceled', canceledAt: now, nextRetryAt: null });
    locked.status = 'canceled';
    locked.canceledAt = now;
    locked.nextRetryAt = null;

    const scope = { merchantId: locked.merchantId, livemode: locked.livemode };
    const [customer, price, merchant] = await Promise.all([
      this.customers.requireInScope(scope, locked.customerId),
      this.priceRows.findById(locked.priceId),
      this.merchants.getById(locked.merchantId),
    ]);
    if (price) {
      await this.notices.canceled(manager, { subscription: locked, customer, price, merchantName: merchant.displayName });
    }
    this.logger.info('subscription_canceled', { subscription_id: locked.id });
  }

  /** A `setup` session's card becomes the subscription's, in the session's completing commit. */
  async useCard(manager: EntityManager, id: SubscriptionId, paymentMethodId: PaymentMethodId): Promise<void> {
    await this.subscriptions.patch(manager, id, { defaultPaymentMethodId: paymentMethodId });
  }

  protected override notFound(id: string): ResourceNotFoundException {
    return new ResourceNotFoundException('subscription', id);
  }
}

function scopeFrom(principal: AuthPrincipal): MerchantScope {
  return { merchantId: merchantIdOf(principal), livemode: livemodeOf(principal) };
}

function isSubscriptionStatus(value: string): value is SubscriptionStatus {
  return (SUBSCRIPTION_STATUSES as readonly string[]).includes(value);
}
