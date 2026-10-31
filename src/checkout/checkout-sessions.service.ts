/**
 * CheckoutSessionsService — L7. The hosted payment page and the embedded iframe.
 *
 * A session wraps exactly one PaymentIntent, created in the same request with automatic
 * capture. Everything that moves money goes through the intent and its flows; this service adds
 * what the shopper sees and where they are sent, and keeps the session's own `status` in step
 * with the intent:
 *
 *   open ──(intent succeeded, or authorised and not held for review)──▶ complete
 *   open ──(past expires_at, or the intent was cancelled)──────────────▶ expired
 *
 * Both are reconciled lazily on every read and by `CheckoutExpiryJob`, so neither depends on the
 * other having run. There are no checkout bus events: a merchant fulfils on `payment.captured`.
 *
 * RFC platform-v2 gave a session a `mode`:
 *
 *   payment       charges once; may save the card (`save_payment_method: 'optional'` and the
 *                 shopper ticked it) and may be paid in the shopper's local currency (§7)
 *   subscription  charges the first period of a recurring price; completion saves the card and
 *                 starts the subscription in the same commit (§6)
 *   setup         charges nothing — its zero-amount intent only carries the vault bearer — and
 *                 saves a card; for a past-due subscription it becomes the subscription's card
 *                 and the overdue renewal is retried at once (§6)
 *
 * Completion work happens in the transaction that moves the session to `complete`, so a
 * complete session always has the card it promised to save and the subscription it sold.
 *
 * Two read shapes on purpose (`CheckoutSession` / `CheckoutSessionPublic`): the public one is
 * what the shopper's browser holds and carries no metadata, no customer reference and no
 * merchant id.
 */
import { randomBytes } from 'node:crypto';

import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { CHECKOUT_SESSION_STATUSES, COUNTRY_CURRENCY } from '@payzeno/contracts';
import type {
  AuthPrincipal,
  CheckoutPaymentError,
  CheckoutSession,
  CheckoutSessionPublic,
  CheckoutSessionStatus,
  CurrencyCode,
  CurrencyOption,
  ListQuery,
  Paginated,
  Presentment,
} from '@payzeno/contracts';

import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import type { PriceEntity } from '../billing/recurring/price.entity';
import { PricesService } from '../billing/recurring/prices.service';
import { SubscriptionRenewalService } from '../billing/recurring/subscription-renewal.service';
import type { SubscriptionEntity } from '../billing/recurring/subscription.entity';
import { SubscriptionsService } from '../billing/recurring/subscriptions.service';
import { BaseService } from '../common/base/base.service';
import { scopeOf as scopeOfRow, type MerchantScope } from '../common/base/merchant-scoped.entity';
import { ConflictException, ValidationException } from '../common/errors/api.exception';
import { CardDeclinedException } from '../common/errors/card.exceptions';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { minimumChargeableMinor } from '../common/money/money.util';
import { resolveListQuery } from '../common/pagination/list-query.dto';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { assertCallbackUrl } from '../common/validators/callback-url';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import type { CustomerEntity } from '../customers/customer.entity';
import { CustomerRepository } from '../customers/customer.repository';
import { CustomersService } from '../customers/customers.service';
import { FxService } from '../fx/fx.service';
import { MerchantsService } from '../merchants/merchants.service';
import type { PaymentMethodEntity } from '../payment-methods/payment-method.entity';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import { ChargeRepository } from '../payments/charge.repository';
import type { PaymentIntentEntity } from '../payments/payment-intent.entity';
import { PaymentIntentRepository } from '../payments/payment-intent.repository';
import { PaymentIntentsService } from '../payments/payment-intents.service';
import { shopperContextFrom, UNKNOWN_SHOPPER, type ShopperContext } from '../payments/shopper-context';
import type { TokenResolution } from '../payments/vault/vault.types';
import { ReviewRepository } from '../risk/review.repository';

import { CHECKOUT_SESSION_TTL_MS, CheckoutSessionEntity } from './checkout-session.entity';
import { CheckoutSessionRepository } from './checkout-session.repository';
import type { ConfirmCheckoutSessionDto } from './dto/confirm-checkout-session.dto';
import type { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';

/** A renewal's "update your card" link has to outlive the retries it is emailed between. */
export const RENEWAL_SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What a read reconciles together: the session row and the intent behind it. */
interface ReconciledSession {
  session: CheckoutSessionEntity;
  intent: PaymentIntentEntity;
}

type HeaderBag = Record<string, string | string[] | undefined>;

@Injectable()
export class CheckoutSessionsService extends BaseService<CheckoutSessionEntity> {
  constructor(
    private readonly sessions: CheckoutSessionRepository,
    private readonly paymentIntents: PaymentIntentsService,
    private readonly intents: PaymentIntentRepository,
    private readonly charges: ChargeRepository,
    private readonly merchants: MerchantsService,
    private readonly customers: CustomersService,
    private readonly customerRows: CustomerRepository,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly fx: FxService,
    private readonly reviews: ReviewRepository,
    @Inject(forwardRef(() => PricesService)) private readonly prices: PricesService,
    @Inject(forwardRef(() => SubscriptionsService)) private readonly subscriptions: SubscriptionsService,
    @Inject(forwardRef(() => SubscriptionRenewalService)) private readonly renewals: SubscriptionRenewalService,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(sessions, logger);
  }

  get entityName(): string {
    return 'checkout_session';
  }

  /** The shopper as the pay host saw them. The override header counts outside production only. */
  shopperFrom(headers: HeaderBag): ShopperContext {
    return shopperContextFrom(headers, this.config.runtime.nodeEnv);
  }

  /**
   * `POST /v1/checkout/sessions`. `livemode` comes from the api key, never from the body — the
   * intent behind the session is created with the same principal's scope.
   */
  async create(principal: AuthPrincipal, dto: CreateCheckoutSessionDto): Promise<CheckoutSession> {
    const scope = scopeFrom(principal);
    const uiMode = dto.ui_mode ?? 'hosted';
    const mode = dto.mode ?? 'payment';
    this.assertCreatable(uiMode, dto);
    // Before anything is written: a live session for a merchant that cannot charge live is a 403.
    await this.paymentIntents.assertMayChargeLive(scope);

    // -- who and what -------------------------------------------------------------------
    let subscription: SubscriptionEntity | null = null;
    let customer: CustomerEntity | null = null;
    let price: PriceEntity | null = null;

    if (dto.subscription_id) {
      if (mode !== 'setup') {
        throw invalid('subscription_id', 'only a setup session repairs a subscription', 'mode_mismatch');
      }
      subscription = await this.subscriptions.requireInScope(scope, dto.subscription_id);
      customer = await this.customers.requireInScope(scope, subscription.customerId);
    }
    if (dto.customer_id) {
      const named = await this.customers.requireInScope(scope, dto.customer_id);
      if (customer && named.id !== customer.id) {
        throw invalid('customer_id', 'the subscription belongs to another customer', 'customer_mismatch');
      }
      customer = named;
    }
    if (mode === 'subscription') {
      if (!dto.price_id) throw invalid('price_id', 'a subscription session sells a recurring price', 'required');
      price = await this.prices.requireRecurring(scope, dto.price_id);
    } else if (dto.price_id) {
      throw invalid('price_id', 'only a subscription session takes a price', 'mode_mismatch');
    }
    if (mode !== 'payment' && !customer && !dto.customer_email) {
      // Subscription and setup always save the card, so they always need a customer.
      throw invalid('customer_id', `a ${mode} session needs customer_id or customer_email`, 'required');
    }

    // -- how much -------------------------------------------------------------------------
    const { amountMinor, currency } = await this.priceSession(scope, mode, dto, price, subscription);

    const id = this.ids.checkoutSessionId();
    const now = this.clock.now();
    const metadata = dto.metadata ?? {};
    const lineItems = (dto.line_items ?? []).map((item) => ({
      name: item.name,
      quantity: item.quantity,
      unit_amount_minor: item.unit_amount_minor,
    }));
    if (price && lineItems.length === 0) {
      lineItems.push({ name: price.productName, quantity: 1, unit_amount_minor: Number(price.unitAmountMinor) });
    }

    const row = await this.transactions.runInTransaction(async (manager) => {
      const createCustomer = !customer && (mode !== 'payment' || dto.customer_creation === 'always');
      const sessionCustomer = createCustomer
        ? await this.customers.createInternal(scope, { email: dto.customer_email ?? null, name: null }, manager)
        : customer;
      const customerEmail = dto.customer_email ?? sessionCustomer?.email ?? null;

      const intent = await this.paymentIntents.createInternal(
        scope,
        {
          amount_minor: amountMinor,
          currency,
          // A setup intent is never confirmed; `manual` says so to anyone reading the row.
          capture_method: mode === 'setup' ? 'manual' : 'automatic',
          description: dto.description ?? price?.productName ?? null,
          customer_reference: dto.customer_reference ?? null,
          customer_id: sessionCustomer?.id ?? null,
          receipt_email: mode === 'setup' ? null : customerEmail,
          // The way back from a payment.* webhook to the session that took it.
          metadata: { ...metadata, checkout_session_id: id },
        },
        manager,
      );

      const session = new CheckoutSessionEntity();
      session.id = id;
      session.merchantId = scope.merchantId;
      session.livemode = scope.livemode;
      session.paymentIntentId = intent.id;
      session.status = 'open';
      session.uiMode = uiMode;
      session.mode = mode;
      session.amountMinor = amountMinor;
      session.currency = currency;
      session.description = dto.description ?? null;
      session.lineItems = lineItems;
      session.customerReference = dto.customer_reference ?? null;
      session.customerEmail = customerEmail;
      session.customerId = sessionCustomer?.id ?? null;
      session.priceId = price?.id ?? null;
      session.subscriptionId = subscription?.id ?? null;
      // Only `payment` mode asks; subscription and setup save the card by definition.
      session.savePaymentMethod =
        mode === 'payment' ? (dto.save_payment_method ?? (sessionCustomer ? 'optional' : 'never')) : 'never';
      session.adaptivePricing = mode === 'payment' && (dto.adaptive_pricing ?? true);
      session.saveCardRequested = false;
      session.successUrl = dto.success_url ?? null;
      session.cancelUrl = dto.cancel_url ?? null;
      session.allowedOrigin = dto.allowed_origin ? new URL(dto.allowed_origin).origin : null;
      session.clientSecret = mintSessionSecret(id);
      session.metadata = metadata;
      session.expiresAt = new Date(now.getTime() + CHECKOUT_SESSION_TTL_MS);
      session.completedAt = null;
      session.createdAt = now;
      session.updatedAt = now;
      await this.sessions.insertSession(manager, session);
      return session;
    });

    this.logger.info('checkout_session_created', {
      checkout_session_id: id,
      payment_intent_id: row.paymentIntentId,
      merchant_id: row.merchantId,
      ui_mode: uiMode,
      mode,
      amount_minor: row.amountMinor,
      currency: row.currency,
      livemode: row.livemode,
    });

    return this.toCheckoutSession(row);
  }

  /**
   * The "update your card" link a failed renewal emails: a hosted `setup` session for the
   * subscription's customer, alive for a week (the link has to outlive the retries it sits
   * between). It lands on the checkout host's own `/c/<id>/complete` page — the merchant's
   * success URL is for orders, and this is not one.
   */
  async createRenewalSetupSession(
    subscription: SubscriptionEntity,
    customer: CustomerEntity,
    price: PriceEntity,
  ): Promise<string> {
    const scope = scopeOfRow(subscription);
    const id = this.ids.checkoutSessionId();
    const now = this.clock.now();

    const created = await this.transactions.runInTransaction(async (manager) => {
      const intent = await this.paymentIntents.createInternal(
        scope,
        {
          amount_minor: 0,
          currency: price.currency,
          capture_method: 'manual',
          description: `Update the card for ${price.productName}`,
          customer_id: customer.id,
          metadata: { checkout_session_id: id, subscription_id: subscription.id },
        },
        manager,
      );

      const session = new CheckoutSessionEntity();
      session.id = id;
      session.merchantId = scope.merchantId;
      session.livemode = scope.livemode;
      session.paymentIntentId = intent.id;
      session.status = 'open';
      session.uiMode = 'hosted';
      session.mode = 'setup';
      session.amountMinor = 0;
      session.currency = price.currency;
      session.description = `Update the card for ${price.productName}`;
      session.lineItems = [];
      session.customerReference = null;
      session.customerEmail = customer.email;
      session.customerId = customer.id;
      session.priceId = null;
      session.subscriptionId = subscription.id;
      session.savePaymentMethod = 'never';
      session.adaptivePricing = false;
      session.saveCardRequested = false;
      session.successUrl = `${this.config.checkout.publicUrl}/c/${encodeURIComponent(id)}/complete`;
      session.cancelUrl = null;
      session.allowedOrigin = null;
      session.clientSecret = mintSessionSecret(id);
      session.metadata = { subscription_id: subscription.id };
      session.expiresAt = new Date(now.getTime() + RENEWAL_SETUP_TTL_MS);
      session.completedAt = null;
      session.createdAt = now;
      session.updatedAt = now;
      await this.sessions.insertSession(manager, session);
      return session;
    });

    this.logger.info('checkout_setup_session_created', { checkout_session_id: id, subscription_id: subscription.id });
    return hostedUrl(this.config.checkout.publicUrl, id, created.clientSecret);
  }

  async list(
    principal: AuthPrincipal,
    query: ListQuery,
    status?: CheckoutSessionStatus,
  ): Promise<Paginated<CheckoutSession>> {
    // `?status=` arrives unvalidated; an unknown value would otherwise reach the enum cast.
    if (status !== undefined && !(CHECKOUT_SESSION_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationException('Unknown checkout session status', [
        { path: 'status', code: 'invalid_value', message: CHECKOUT_SESSION_STATUSES.join(', ') },
      ]);
    }

    const page = await this.sessions.listScoped(scopeFrom(principal), resolveListQuery(query), status);
    const data: CheckoutSession[] = [];
    for (const row of page.data) {
      const { session } = await this.reconcile(row);
      data.push(this.toCheckoutSession(session));
    }
    return { data, has_more: page.has_more, next_cursor: page.next_cursor };
  }

  async get(principal: AuthPrincipal, id: string): Promise<CheckoutSession> {
    const row = await this.findOneOrThrow(id, scopeFrom(principal));
    const { session } = await this.reconcile(row);
    return this.toCheckoutSession(session);
  }

  /** `GET /v1/checkout/sessions/:id/public` — `CheckoutSecretGuard` has pinned the principal. */
  async getPublic(principal: AuthPrincipal, id: string, shopper: ShopperContext = UNKNOWN_SHOPPER): Promise<CheckoutSessionPublic> {
    const row = await this.findOneOrThrow(id, scopeFrom(principal));
    return this.toPublic(await this.reconcile(row), shopper);
  }

  /**
   * `POST /v1/checkout/sessions/:id/confirm`.
   *
   * With a token or a saved card: confirm the intent as the session's merchant — the principal
   * is the session secret's, pinned to this session's intent. Without either: resume a payment
   * waiting on 3-D Secure. A card decline (or a §8 block) is an ordinary outcome of a checkout
   * page, not an error the page should show as a failed request: it answers 200 with the public
   * view, `last_error` set and the intent back in `requires_payment_method`, ready for another
   * card. A `setup` session saves the card and completes without charging.
   */
  async confirm(
    principal: AuthPrincipal,
    id: string,
    dto: ConfirmCheckoutSessionDto,
    shopper: ShopperContext = UNKNOWN_SHOPPER,
  ): Promise<CheckoutSessionPublic> {
    const row = await this.findOneOrThrow(id, scopeFrom(principal));
    const current = await this.reconcile(row);
    const { session, intent } = current;

    if (session.status === 'complete') {
      // Already paid. A double-clicked "Pay" must not look like a failure.
      return this.toPublic(current, shopper);
    }
    if (session.status === 'expired') {
      throw new ConflictException('This checkout session has expired', {
        checkout_session_id: id,
        reason: 'checkout_session_expired',
      });
    }
    if (dto.payment_method_token && dto.payment_method_id) {
      throw invalid('payment_method_id', 'send a new card token or a saved card, not both', 'conflict');
    }

    if (session.mode === 'setup') {
      return this.confirmSetup(current, dto, shopper);
    }

    const resuming = !dto.payment_method_token && !dto.payment_method_id;
    if (resuming && intent.status !== 'requires_action') {
      throw new ValidationException('A payment method is required to pay this checkout session', [
        { path: 'payment_method_token', code: 'required', message: 'tokenize a card at the vault first' },
      ]);
    }

    const scope = scopeOfRow(session);
    let card: PaymentMethodEntity | null = null;
    if (dto.payment_method_id) {
      if (!session.customerId) throw new ResourceNotFoundException('payment_method', dto.payment_method_id);
      card = await this.paymentMethods.getUsable(scope, session.customerId, dto.payment_method_id);
    }
    const token = card ? card.vaultToken : (dto.payment_method_token ?? null);

    if (token) {
      await this.applyCurrency(session, intent, dto);
      if (session.mode === 'payment') {
        const wantsSave = !card && dto.save_payment_method === true && session.savePaymentMethod === 'optional';
        if (wantsSave !== session.saveCardRequested) {
          await this.sessions.patchSession(session.id, { saveCardRequested: wantsSave });
          session.saveCardRequested = wantsSave;
        }
      }
    }

    const returnUrl = dto.return_url ?? `${this.config.checkout.publicUrl}/c/${encodeURIComponent(id)}/return`;

    try {
      await this.paymentIntents.confirmInScope(
        scope,
        intent.id,
        token ? { payment_method_token: token, return_url: returnUrl } : {},
        { shopper, paymentMethodId: card?.id ?? null },
      );
    } catch (err) {
      if (!(err instanceof CardDeclinedException)) throw err;
      this.logger.info('checkout_session_payment_declined', {
        checkout_session_id: id,
        payment_intent_id: intent.id,
        decline_code: err.declineCode,
      });
    }

    const fresh = await this.findOneOrThrow(id, scopeFrom(principal));
    return this.toPublic(await this.reconcile(fresh), shopper);
  }

  /**
   * CheckoutExpiryJob. Open sessions past `expires_at` — the same `expire` the lazy reconcile
   * uses, so a session is expired and its intent cancelled exactly once whichever gets there.
   */
  async expireDue(now: Date, limit: number): Promise<{ expired: number; failed: number }> {
    const due = await this.sessions.findOpenPastExpiry(now, limit);
    let expired = 0;
    let failed = 0;

    for (const session of due) {
      try {
        const { session: after } = await this.reconcile(session);
        if (after.status === 'expired') expired += 1;
      } catch (err) {
        failed += 1;
        this.logger.error('checkout_session_expire_failed', err, { checkout_session_id: session.id });
      }
    }

    return { expired, failed };
  }

  // -- setup mode ------------------------------------------------------------------------

  /**
   * Save the card (or pick a saved one), make it the customer's default and — when the session
   * repairs a subscription — the subscription's, and complete, all in one commit. A past-due
   * subscription's overdue period is then charged straight away on the new card.
   */
  private async confirmSetup(
    current: ReconciledSession,
    dto: ConfirmCheckoutSessionDto,
    shopper: ShopperContext,
  ): Promise<CheckoutSessionPublic> {
    const { session } = current;
    const scope = scopeOfRow(session);
    const customerId = session.customerId;
    if (!customerId) {
      throw new ConflictException('This setup session has no customer to save a card to', { checkout_session_id: session.id });
    }

    let saved: PaymentMethodEntity | null = null;
    let resolution: TokenResolution | null = null;
    if (dto.payment_method_id) {
      saved = await this.paymentMethods.getUsable(scope, customerId, dto.payment_method_id);
    } else if (dto.payment_method_token) {
      resolution = await this.paymentMethods.resolve(dto.payment_method_token);
    } else {
      throw new ValidationException('A card is required to complete this checkout session', [
        { path: 'payment_method_token', code: 'required', message: 'tokenize a card at the vault first' },
      ]);
    }

    const completed = await this.transactions.runInTransaction(async (manager) => {
      if ((await this.sessions.markComplete(session.id, this.clock.now(), manager)) === 0) return false;
      const card = saved ?? (resolution ? await this.paymentMethods.attach(manager, scope, customerId, resolution) : null);
      if (!card) return false;
      await this.customerRows.setDefaultPaymentMethod(manager, customerId, card.id, false);
      await this.intents.linkBilling(manager, session.paymentIntentId, { payment_method_id: card.id });
      if (session.subscriptionId) {
        await this.subscriptions.useCard(manager, session.subscriptionId, card.id);
      }
      return true;
    });

    if (completed && session.subscriptionId) {
      this.logger.info('checkout_setup_completed', { checkout_session_id: session.id, subscription_id: session.subscriptionId });
      try {
        // Only a past-due subscription is due; for an active one this is a no-op.
        await this.renewals.retryNow(session.subscriptionId);
      } catch (err) {
        this.logger.error('checkout_setup_retry_failed', err, { subscription_id: session.subscriptionId });
      }
    }

    const fresh = await this.findOneOrThrow(session.id, scope);
    return this.toPublic(await this.reconcile(fresh), shopper);
  }

  // -- adaptive pricing (§7) -----------------------------------------------------------------

  /**
   * Prices the intent in the currency the shopper picked: the session's own, or a local one at
   * a quote this session was shown. Only while the intent waits for a payment method — a price
   * never changes under an authorisation.
   */
  private async applyCurrency(
    session: CheckoutSessionEntity,
    intent: PaymentIntentEntity,
    dto: ConfirmCheckoutSessionDto,
  ): Promise<void> {
    let amountMinor = Number(session.amountMinor);
    let currency: CurrencyCode = session.currency;
    let presentment: Presentment | null = null;

    if (dto.currency && dto.currency !== session.currency) {
      if (!session.adaptivePricing) {
        throw invalid('currency', `this session is paid in ${session.currency}`, 'currency_not_offered');
      }
      if (!dto.fx_quote_id) {
        throw invalid('fx_quote_id', 'paying in another currency needs the quote it was offered at', 'required');
      }
      const quote = await this.fx.requireSpendableQuote(dto.fx_quote_id, session.id, session.currency, dto.currency);
      amountMinor = this.fx.convert(amountMinor, session.currency, dto.currency, quote.rate);
      currency = dto.currency;
      presentment = {
        original_amount_minor: Number(session.amountMinor),
        original_currency: session.currency,
        fx_rate: quote.rate,
        fx_quote_id: quote.id,
      };
    }

    const unchanged =
      Number(intent.amount_minor) === amountMinor &&
      intent.currency === currency &&
      (intent.presentment?.fx_quote_id ?? null) === (presentment?.fx_quote_id ?? null);
    if (unchanged) return;

    const affected = await this.transactions.runInTransaction((manager) =>
      this.intents.applyPresentment(manager, intent.id, { amount_minor: amountMinor, currency, presentment }),
    );
    if (affected === 0) {
      throw new ConflictException('This payment is already being processed', {
        checkout_session_id: session.id,
        reason: 'payment_in_progress',
      });
    }
    intent.amount_minor = amountMinor;
    intent.currency = currency;
    intent.presentment = presentment;
  }

  /** §7: the session currency first, then the shopper's local one at a quote. Empty when not offered. */
  private async currencyOptions(
    session: CheckoutSessionEntity,
    intent: PaymentIntentEntity,
    shopper: ShopperContext,
  ): Promise<CurrencyOption[]> {
    if (!session.adaptivePricing || session.mode !== 'payment' || session.status !== 'open') return [];
    if (intent.status !== 'requires_payment_method' && intent.status !== 'requires_confirmation') return [];

    const local = shopper.country ? COUNTRY_CURRENCY[shopper.country] : undefined;
    if (!local || local === session.currency) return [];

    const quote = await this.fx.quoteForSession(session.id, session.currency, local);
    if (!quote) return [];

    const converted = this.fx.convert(Number(session.amountMinor), session.currency, local, quote.rate);
    if (converted < minimumChargeableMinor(local)) return [];

    return [
      { currency: session.currency, amount_minor: Number(session.amountMinor), fx_quote_id: null, rate: null, recommended: false },
      { currency: local, amount_minor: converted, fx_quote_id: quote.id, rate: quote.rate, recommended: true },
    ];
  }

  // -- reconcile -----------------------------------------------------------

  /**
   * Brings an `open` session in step with its intent: paid → `complete` (with the completion
   * work), past the deadline or cancelled → `expired`. A terminal session is returned as is.
   */
  private async reconcile(session: CheckoutSessionEntity): Promise<ReconciledSession> {
    const intent = await this.intents.findScoped(session.paymentIntentId, scopeOfRow(session));
    if (!intent) {
      // The FK makes this unreachable; if it happens the row is corrupt, not missing.
      throw new ResourceNotFoundException('payment_intent', session.paymentIntentId);
    }

    if (session.status !== 'open') return { session, intent };

    if (session.mode !== 'setup' && isPaid(intent)) {
      return this.complete(session, intent);
    }

    const now = this.clock.now();
    // A cancelled intent (the analyst declined the review, the merchant cancelled) can never be
    // paid: the session is over now, not at its deadline.
    if (session.expiresAt.getTime() <= now.getTime() || intent.status === 'canceled') {
      return this.expire(session, intent);
    }

    return { session, intent };
  }

  /**
   * The paid session's completion, in one commit with `open → complete`: save the card when the
   * shopper asked (or the mode requires it), and start the subscription. If any of it fails the
   * session stays `open` over a paid intent and the next read tries again.
   */
  private async complete(session: CheckoutSessionEntity, intent: PaymentIntentEntity): Promise<ReconciledSession> {
    const scope = scopeOfRow(session);
    const savesCard = session.mode === 'subscription' || session.saveCardRequested;

    try {
      // The vault call happens before the transaction, never inside one.
      const resolution =
        savesCard && !intent.payment_method_id && intent.payment_method_token
          ? await this.paymentMethods.resolve(intent.payment_method_token)
          : null;
      const price = session.mode === 'subscription' && session.priceId
        ? await this.prices.requireRecurring(scope, session.priceId)
        : null;
      const merchantName = price ? (await this.merchants.getById(session.merchantId)).displayName : '';
      const now = this.clock.now();

      const completed = await this.transactions.runInTransaction(async (manager) => {
        if ((await this.sessions.markComplete(session.id, now, manager)) === 0) return false;
        if (!savesCard) return true;

        let customer = session.customerId ? await this.customers.requireInScope(scope, session.customerId) : null;
        if (!customer) {
          // `customer_creation: 'if_required'` — the shopper asked to save, so now it is required.
          customer = await this.customers.createInternal(scope, { email: session.customerEmail, name: null }, manager);
          await this.sessions.patchSession(session.id, { customerId: customer.id }, manager);
          await this.intents.linkBilling(manager, intent.id, { customer_id: customer.id });
          session.customerId = customer.id;
        }

        const card = intent.payment_method_id
          ? await this.paymentMethods.getUsable(scope, customer.id, intent.payment_method_id)
          : resolution
            ? await this.paymentMethods.attach(manager, scope, customer.id, resolution)
            : null;
        if (!card) return true;

        await this.customerRows.setDefaultPaymentMethod(manager, customer.id, card.id, true);
        await this.intents.linkBilling(manager, intent.id, { payment_method_id: card.id });

        if (price) {
          const subscription = await this.subscriptions.startFromCheckout(manager, {
            scope,
            customer,
            price,
            paymentMethod: card,
            intent,
            merchantName,
          });
          await this.sessions.patchSession(session.id, { subscriptionId: subscription.id }, manager);
          session.subscriptionId = subscription.id;
        }
        return true;
      });

      if (!completed) return { session: await this.reload(session), intent };

      session.status = 'complete';
      session.completedAt = now;
      this.logger.info('checkout_session_completed', {
        checkout_session_id: session.id,
        payment_intent_id: intent.id,
        intent_status: intent.status,
        mode: session.mode,
        subscription_id: session.subscriptionId,
      });
    } catch (err) {
      this.logger.error('checkout_session_completion_failed', err, {
        checkout_session_id: session.id,
        payment_intent_id: intent.id,
      });
    }
    return { session, intent };
  }

  private async expire(
    session: CheckoutSessionEntity,
    intent: PaymentIntentEntity,
  ): Promise<ReconciledSession> {
    if ((await this.sessions.markExpired(session.id)) === 0) {
      return { session: await this.reload(session), intent };
    }
    session.status = 'expired';

    if (!intent.isTerminal()) {
      try {
        const canceled = await this.paymentIntents.cancelInScope(scopeOfRow(session), intent.id, {
          cancellation_reason: 'abandoned',
        });
        intent.status = canceled.status;
      } catch (err) {
        // The session is expired either way; an intent that would not cancel is the job's
        // and the merchant's to see, not a reason to keep the session open.
        this.logger.warn('checkout_session_intent_cancel_failed', {
          checkout_session_id: session.id,
          payment_intent_id: intent.id,
          intent_status: intent.status,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    this.logger.info('checkout_session_expired', {
      checkout_session_id: session.id,
      payment_intent_id: intent.id,
    });
    return { session, intent };
  }

  private async reload(session: CheckoutSessionEntity): Promise<CheckoutSessionEntity> {
    return (await this.sessions.findScoped(session.id, scopeOfRow(session))) ?? session;
  }

  // -- validation ------------------------------------------------------------

  private assertCreatable(uiMode: 'hosted' | 'embedded', dto: CreateCheckoutSessionDto): void {
    const nodeEnv = this.config.runtime.nodeEnv;

    if (uiMode === 'hosted' && !dto.success_url) {
      throw new ValidationException('success_url is required for a hosted checkout session', [
        { path: 'success_url', code: 'required', message: 'where to send the shopper after paying' },
      ]);
    }
    if (uiMode === 'embedded' && !dto.allowed_origin) {
      throw new ValidationException('allowed_origin is required for an embedded checkout session', [
        { path: 'allowed_origin', code: 'required', message: 'the origin that frames the checkout' },
      ]);
    }

    if (dto.success_url) assertCallbackUrl(dto.success_url, 'success_url', nodeEnv);
    if (dto.cancel_url) assertCallbackUrl(dto.cancel_url, 'cancel_url', nodeEnv);
    if (dto.allowed_origin) {
      assertCallbackUrl(dto.allowed_origin, 'allowed_origin', nodeEnv, { originOnly: true });
    }
  }

  /** What the session charges: the request's amount, the price's, or nothing for `setup`. */
  private async priceSession(
    scope: MerchantScope,
    mode: CheckoutSessionEntity['mode'],
    dto: CreateCheckoutSessionDto,
    price: PriceEntity | null,
    subscription: SubscriptionEntity | null,
  ): Promise<{ amountMinor: number; currency: CurrencyCode }> {
    if (mode === 'setup') {
      if (dto.amount_minor !== undefined) throw invalid('amount_minor', 'a setup session charges nothing', 'mode_mismatch');
      const subscriptionPrice = subscription ? await this.prices.requireRecurring(scope, subscription.priceId) : null;
      const currency =
        subscriptionPrice?.currency ?? dto.currency ?? (await this.merchants.getById(scope.merchantId)).defaultCurrency;
      return { amountMinor: 0, currency };
    }

    if (mode === 'subscription' && price) {
      const amountMinor = Number(price.unitAmountMinor);
      if (dto.amount_minor !== undefined && dto.amount_minor !== amountMinor) {
        throw invalid('amount_minor', `the price charges ${amountMinor}`, 'amount_mismatch');
      }
      if (dto.currency !== undefined && dto.currency !== price.currency) {
        throw invalid('currency', `the price is in ${price.currency}`, 'currency_mismatch');
      }
      return { amountMinor, currency: price.currency };
    }

    if (dto.amount_minor === undefined) throw invalid('amount_minor', 'a payment session needs an amount', 'required');
    if (dto.currency === undefined) throw invalid('currency', 'a payment session needs a currency', 'required');

    if (dto.line_items && dto.line_items.length > 0) {
      const total = dto.line_items.reduce((sum, item) => sum + item.quantity * item.unit_amount_minor, 0);
      if (total !== dto.amount_minor) {
        throw new ValidationException('line_items do not add up to amount_minor', [
          {
            path: 'line_items',
            code: 'amount_mismatch',
            message: `line items total ${total}, amount_minor is ${dto.amount_minor}`,
          },
        ]);
      }
    }
    return { amountMinor: dto.amount_minor, currency: dto.currency };
  }

  // -- wire shapes -------------------------------------------------------------

  private toCheckoutSession(row: CheckoutSessionEntity): CheckoutSession {
    return {
      id: row.id,
      object: 'checkout_session',
      merchant_id: row.merchantId,
      payment_intent_id: row.paymentIntentId,
      status: row.status,
      ui_mode: row.uiMode,
      mode: row.mode,
      customer_id: row.customerId,
      price_id: row.priceId,
      subscription_id: row.subscriptionId,
      save_payment_method: row.savePaymentMethod,
      amount_minor: Number(row.amountMinor),
      currency: row.currency,
      description: row.description,
      line_items: row.lineItems,
      customer_reference: row.customerReference,
      customer_email: row.customerEmail,
      success_url: row.successUrl,
      cancel_url: row.cancelUrl,
      allowed_origin: row.allowedOrigin,
      url: row.uiMode === 'hosted' ? hostedUrl(this.config.checkout.publicUrl, row.id, row.clientSecret) : null,
      client_secret: row.clientSecret,
      livemode: row.livemode,
      metadata: row.metadata,
      created_at: row.createdAt.toISOString(),
      expires_at: row.expiresAt.toISOString(),
      completed_at: row.completedAt ? row.completedAt.toISOString() : null,
    };
  }

  /** No metadata, no customer reference, no merchant id — see the header. */
  private async toPublic({ session, intent }: ReconciledSession, shopper: ShopperContext): Promise<CheckoutSessionPublic> {
    const scope = scopeOfRow(session);
    const [merchant, price, cards, review, currencyOptions, lastError] = await Promise.all([
      this.merchants.getById(session.merchantId),
      session.priceId ? this.prices.requireRecurring(scope, session.priceId).catch(() => null) : Promise.resolve(null),
      session.customerId ? this.paymentMethods.list(scope, session.customerId) : Promise.resolve([]),
      intent.review_id ? this.reviews.findById(intent.review_id) : Promise.resolve(null),
      this.currencyOptions(session, intent, shopper),
      this.lastError(intent),
    ]);

    return {
      id: session.id,
      object: 'checkout_session_public',
      status: session.status,
      ui_mode: session.uiMode,
      mode: session.mode,
      recurring: price?.recurring() ?? null,
      currency_options: currencyOptions,
      saved_payment_methods: cards.map((card) => ({ id: card.id, card: card.card() })),
      save_payment_method: session.savePaymentMethod,
      amount_minor: Number(session.amountMinor),
      currency: session.currency,
      description: session.description,
      line_items: session.lineItems,
      customer_email: session.customerEmail,
      merchant: {
        display_name: merchant.displayName,
        statement_descriptor: merchant.statementDescriptor,
      },
      payment: {
        status: intent.status,
        client_secret: intent.client_secret,
        next_action: intent.next_action,
        last_error: lastError,
        review: review ? { id: review.id, status: review.status } : null,
        currency: intent.currency,
        amount_minor: Number(intent.amount_minor),
      },
      success_url: session.successUrl,
      cancel_url: session.cancelUrl,
      allowed_origin: session.allowedOrigin,
      livemode: session.livemode,
      expires_at: session.expiresAt.toISOString(),
    };
  }

  /**
   * The latest attempt's decline, while the intent is waiting for another card (or gave up). A
   * §8 block is a voided charge carrying `fraud_suspected`, and reads the same as a decline.
   */
  private async lastError(intent: PaymentIntentEntity): Promise<CheckoutPaymentError | null> {
    if (!intent.latest_charge_id) return null;
    if (intent.status !== 'requires_payment_method' && intent.status !== 'failed') return null;

    const charge = await this.charges.findOne({ where: { id: intent.latest_charge_id } });
    if (!charge) return null;
    if (charge.status !== 'failed' && !charge.failure_code) return null;

    return {
      code: charge.failure_code ?? 'processing_error',
      message: charge.failure_message ?? 'The payment could not be completed',
    };
  }

  protected override notFound(id: string): ResourceNotFoundException {
    return new ResourceNotFoundException('checkout_session', id);
  }
}

function scopeFrom(principal: AuthPrincipal): MerchantScope {
  return { merchantId: merchantIdOf(principal), livemode: livemodeOf(principal) };
}

/** Paid, or authorised and not held: a §8 review keeps the session open until it is decided. */
function isPaid(intent: PaymentIntentEntity): boolean {
  return intent.status === 'succeeded' || (intent.status === 'requires_capture' && !intent.review_id);
}

function invalid(path: string, message: string, code: string): ValidationException {
  return new ValidationException(message, [{ path, code, message }]);
}

/** `https://pay.payzeno.com/c/<id>#<client_secret>`; the fragment never reaches a server log. */
function hostedUrl(publicUrl: string, id: string, clientSecret: string): string {
  return `${publicUrl}/c/${encodeURIComponent(id)}#${clientSecret}`;
}

/**
 * `cs_<ulid>_secret_<32 hex>`. Browser-visible, so minted from a CSPRNG and never derived from
 * the id — the same rule as the PaymentIntent client secret.
 */
function mintSessionSecret(id: string): string {
  return `${id}_secret_${randomBytes(16).toString('hex')}`;
}
