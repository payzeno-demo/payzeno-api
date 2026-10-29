import type { AuthPrincipal } from '@payzeno/contracts';
import type { EntityManager } from 'typeorm';

import { PriceEntity } from 'src/billing/recurring/price.entity';
import type { PricesService } from 'src/billing/recurring/prices.service';
import type { SubscriptionRenewalService } from 'src/billing/recurring/subscription-renewal.service';
import { SubscriptionEntity } from 'src/billing/recurring/subscription.entity';
import type { CheckoutStart, SubscriptionsService } from 'src/billing/recurring/subscriptions.service';
import { CheckoutSessionEntity } from 'src/checkout/checkout-session.entity';
import type { CheckoutSessionRepository } from 'src/checkout/checkout-session.repository';
import { CheckoutSessionsService } from 'src/checkout/checkout-sessions.service';
import type { CreateCheckoutSessionDto } from 'src/checkout/dto/create-checkout-session.dto';
import { ValidationException } from 'src/common/errors/api.exception';
import type { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { ApiConfig } from 'src/config/api-config.type';
import { CustomerEntity } from 'src/customers/customer.entity';
import type { CustomerRepository } from 'src/customers/customer.repository';
import type { CustomersService } from 'src/customers/customers.service';
import { FxQuoteEntity } from 'src/fx/fx-quote.entity';
import type { FxService } from 'src/fx/fx.service';
import { MerchantEntity } from 'src/merchants/merchant.entity';
import type { MerchantsService } from 'src/merchants/merchants.service';
import { PaymentMethodEntity } from 'src/payment-methods/payment-method.entity';
import type { PaymentMethodsService } from 'src/payment-methods/payment-methods.service';
import type { ChargeRepository } from 'src/payments/charge.repository';
import type { ConfirmContext } from 'src/payments/flows/confirm-payment.flow';
import { PaymentIntentEntity } from 'src/payments/payment-intent.entity';
import type { PaymentIntentRepository } from 'src/payments/payment-intent.repository';
import type { InternalIntentInput, PaymentIntentsService } from 'src/payments/payment-intents.service';
import type { ReviewRepository } from 'src/risk/review.repository';
import { FixedClock } from 'test/support/fixed-clock';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

const MANAGER = stub<EntityManager>({});
const SCOPE_PRINCIPAL: AuthPrincipal = {
  kind: 'api_key',
  merchant_id: 'mch_1',
  api_key_id: 'key_1',
  mode: 'test',
  scopes: ['checkout_sessions:write'],
};
const SECRET_PRINCIPAL: AuthPrincipal = {
  kind: 'client_secret',
  merchant_id: 'mch_1',
  payment_intent_id: 'pi_1',
  livemode: false,
};

/**
 * Checkout's RFC platform-v2 surface: the three modes, adaptive pricing, saved cards, and the
 * completion work (save the card, start the subscription) done in the completing commit.
 */
describe('CheckoutSessionsService (platform-v2)', () => {
  let session: CheckoutSessionEntity;
  let intent: PaymentIntentEntity;
  let createdIntents: InternalIntentInput[];
  let insertedSessions: CheckoutSessionEntity[];
  let quote: FxQuoteEntity | null;
  let attached: PaymentMethodEntity[];
  let started: CheckoutStart[];
  let defaults: Array<{ customerId: string; pmId: string; onlyIfUnset: boolean }>;
  let subscriptionCards: Array<{ id: string; pm: string }>;
  let retried: string[];
  let presentments: Array<Record<string, unknown>>;
  let confirms: Array<{ request: Record<string, unknown>; context?: ConfirmContext }>;

  function service(): CheckoutSessionsService {
    return new CheckoutSessionsService(
      stub<CheckoutSessionRepository>({
        findScoped: jest.fn(async () => session),
        insertSession: jest.fn(async (_m: EntityManager, row: CheckoutSessionEntity) => {
          insertedSessions.push(row);
        }),
        markComplete: jest.fn(async () => {
          session.status = 'complete';
          return 1;
        }),
        markExpired: jest.fn(async () => 1),
        patchSession: jest.fn(async (_id: string, patch: Partial<CheckoutSessionEntity>) => {
          Object.assign(session, patch);
        }),
      }),
      stub<PaymentIntentsService>({
        assertMayChargeLive: jest.fn(async () => undefined),
        createInternal: jest.fn(async (_scope, input: InternalIntentInput) => {
          createdIntents.push(input);
          return Object.assign(new PaymentIntentEntity(), { id: 'pi_new' });
        }),
        confirmInScope: jest.fn(async (_scope, _id: string, request: Record<string, unknown>, context?: ConfirmContext) => {
          confirms.push({ request, context });
          if (typeof request.payment_method_token === 'string') intent.payment_method_token = request.payment_method_token;
          intent.status = 'succeeded';
          return intent;
        }),
      }),
      stub<PaymentIntentRepository>({
        findScoped: jest.fn(async () => intent),
        applyPresentment: jest.fn(async (_m: EntityManager, _id: string, price: Record<string, unknown>) => {
          presentments.push(price);
          return 1;
        }),
        linkBilling: jest.fn(async () => undefined),
      }),
      stub<ChargeRepository>({ findOne: jest.fn(async () => null) }),
      stub<MerchantsService>({
        getById: jest.fn(async () =>
          Object.assign(new MerchantEntity(), { id: 'mch_1', displayName: 'Northwind', statementDescriptor: null, defaultCurrency: 'USD' }),
        ),
      }),
      stub<CustomersService>({
        requireInScope: jest.fn(async () => customer()),
        createInternal: jest.fn(async () => customer()),
      }),
      stub<CustomerRepository>({
        setDefaultPaymentMethod: jest.fn(async (_m: EntityManager, customerId: string, pmId: string, onlyIfUnset: boolean) => {
          defaults.push({ customerId, pmId, onlyIfUnset });
        }),
      }),
      stub<PaymentMethodsService>({
        resolve: jest.fn(async (token: string) => ({
          token,
          fingerprint: 'fp_1',
          card: { brand: 'visa' as const, last_four: '4242', exp_month: 12, exp_year: 2030, country: 'US', funding: 'credit' as const },
        })),
        attach: jest.fn(async () => {
          const card = Object.assign(new PaymentMethodEntity(), { id: 'pm_new', customerId: 'cus_1', vaultToken: 'pmt_new' });
          attached.push(card);
          return card;
        }),
        getUsable: jest.fn(async () =>
          Object.assign(new PaymentMethodEntity(), { id: 'pm_saved', customerId: 'cus_1', vaultToken: 'pmt_saved' }),
        ),
        list: jest.fn(async () => []),
      }),
      stub<FxService>({
        quoteForSession: jest.fn(async () => quote),
        requireSpendableQuote: jest.fn(async () => quote as FxQuoteEntity),
        convert: jest.fn((amount: number) => Math.round(amount * 0.941562)),
      }),
      stub<ReviewRepository>({ findById: jest.fn(async () => null) }),
      stub<PricesService>({ requireRecurring: jest.fn(async () => price()) }),
      stub<SubscriptionsService>({
        requireInScope: jest.fn(async () => Object.assign(new SubscriptionEntity(), { id: 'csub_1', customerId: 'cus_1', priceId: 'price_1' })),
        startFromCheckout: jest.fn(async (_m: EntityManager, start: CheckoutStart) => {
          started.push(start);
          return Object.assign(new SubscriptionEntity(), { id: 'csub_new' });
        }),
        useCard: jest.fn(async (_m: EntityManager, id: string, pm: string) => {
          subscriptionCards.push({ id, pm });
        }),
      }),
      stub<SubscriptionRenewalService>({
        retryNow: jest.fn(async (id: string) => {
          retried.push(id);
          return 'renewed' as const;
        }),
      }),
      stub<TransactionManager>({ runInTransaction: jest.fn(async <T>(fn: (m: EntityManager) => Promise<T>) => fn(MANAGER)) }),
      stub<IdFactory>({ checkoutSessionId: () => 'cs_new' }),
      stub<ApiConfig>({ checkout: { publicUrl: 'http://pay.localhost' }, runtime: stub<ApiConfig['runtime']>({ nodeEnv: 'development' }) }),
      new FixedClock('2026-10-29T09:00:00.000Z'),
      new NoopLogger(),
    );
  }

  beforeEach(() => {
    session = sessionRow();
    intent = intentRow();
    createdIntents = [];
    insertedSessions = [];
    quote = Object.assign(new FxQuoteEntity(), { id: 'fxq_1', rate: '0.941562' });
    attached = [];
    started = [];
    defaults = [];
    subscriptionCards = [];
    retried = [];
    presentments = [];
    confirms = [];
  });

  describe('create', () => {
    const hosted = { success_url: 'http://shop.localhost/thanks' };

    it('prices a subscription session from its recurring price', async () => {
      const created = await service().create(SCOPE_PRINCIPAL, dto({ ...hosted, mode: 'subscription', price_id: 'price_1', customer_email: 'shopper@example.com' }));

      expect(created).toMatchObject({ mode: 'subscription', amount_minor: 3_800, currency: 'USD', price_id: 'price_1', customer_id: 'cus_1' });
      expect(insertedSessions[0].lineItems).toEqual([{ name: 'Monthly Subscription', quantity: 1, unit_amount_minor: 3_800 }]);
      expect(createdIntents[0]).toMatchObject({ amount_minor: 3_800, customer_id: 'cus_1', receipt_email: 'shopper@example.com' });
    });

    it('refuses a subscription session whose amount disagrees with the price', async () => {
      await expect(
        service().create(SCOPE_PRINCIPAL, dto({ ...hosted, mode: 'subscription', price_id: 'price_1', customer_id: 'cus_1', amount_minor: 100 })),
      ).rejects.toBeInstanceOf(ValidationException);
    });

    it('needs a customer for a subscription or setup session', async () => {
      await expect(service().create(SCOPE_PRINCIPAL, dto({ ...hosted, mode: 'subscription', price_id: 'price_1' }))).rejects.toBeInstanceOf(
        ValidationException,
      );
    });

    it('needs an amount and a currency in payment mode', async () => {
      await expect(service().create(SCOPE_PRINCIPAL, dto({ ...hosted, currency: 'USD' }))).rejects.toBeInstanceOf(ValidationException);
    });

    it('creates a setup session that charges nothing, for the subscription it repairs', async () => {
      const created = await service().create(SCOPE_PRINCIPAL, dto({ ...hosted, mode: 'setup', subscription_id: 'csub_1' }));

      expect(created).toMatchObject({ mode: 'setup', amount_minor: 0, currency: 'USD', subscription_id: 'csub_1', customer_id: 'cus_1' });
      expect(createdIntents[0]).toMatchObject({ amount_minor: 0, capture_method: 'manual', receipt_email: null });
    });

    it('offers to save the card by default only when there is a customer', async () => {
      const anonymous = await service().create(SCOPE_PRINCIPAL, dto({ ...hosted, amount_minor: 1_000, currency: 'USD' }));
      expect(anonymous.save_payment_method).toBe('never');

      const known = await service().create(SCOPE_PRINCIPAL, dto({ ...hosted, amount_minor: 1_000, currency: 'USD', customer_id: 'cus_1' }));
      expect(known.save_payment_method).toBe('optional');
      expect(createdIntents[1].receipt_email).toBe('shopper@example.com');
    });
  });

  describe('adaptive pricing', () => {
    it('offers the shopper’s local currency at a quote, the session currency first', async () => {
      const view = await service().getPublic(SECRET_PRINCIPAL, 'cs_1', { country: 'DE', ip: null });

      expect(view.currency_options).toEqual([
        { currency: 'USD', amount_minor: 3_800, fx_quote_id: null, rate: null, recommended: false },
        { currency: 'EUR', amount_minor: 3_578, fx_quote_id: 'fxq_1', rate: '0.941562', recommended: true },
      ]);
    });

    it('offers nothing at home, nothing without a rate, nothing when switched off', async () => {
      expect((await service().getPublic(SECRET_PRINCIPAL, 'cs_1', { country: 'US', ip: null })).currency_options).toEqual([]);
      quote = null;
      expect((await service().getPublic(SECRET_PRINCIPAL, 'cs_1', { country: 'DE', ip: null })).currency_options).toEqual([]);
      quote = Object.assign(new FxQuoteEntity(), { id: 'fxq_1', rate: '0.941562' });
      session.adaptivePricing = false;
      expect((await service().getPublic(SECRET_PRINCIPAL, 'cs_1', { country: 'DE', ip: null })).currency_options).toEqual([]);
    });

    it('re-prices the intent in the chosen currency with its presentment', async () => {
      await service().confirm(SECRET_PRINCIPAL, 'cs_1', { payment_method_token: 'pmt_new_card_token', currency: 'EUR', fx_quote_id: 'fxq_1' }, { country: 'DE', ip: '85.214.0.9' });

      expect(presentments).toEqual([
        {
          amount_minor: 3_578,
          currency: 'EUR',
          presentment: { original_amount_minor: 3_800, original_currency: 'USD', fx_rate: '0.941562', fx_quote_id: 'fxq_1' },
        },
      ]);
      expect(confirms[0].context?.shopper).toEqual({ country: 'DE', ip: '85.214.0.9' });
    });

    it('needs the quote to pay in another currency', async () => {
      await expect(
        service().confirm(SECRET_PRINCIPAL, 'cs_1', { payment_method_token: 'pmt_new_card_token', currency: 'EUR' }),
      ).rejects.toBeInstanceOf(ValidationException);
    });
  });

  describe('saved cards', () => {
    it('pays with a saved card by its vault token, naming the card on the intent', async () => {
      session.customerId = 'cus_1';
      await service().confirm(SECRET_PRINCIPAL, 'cs_1', { payment_method_id: 'pm_saved' });

      expect(confirms[0].request).toMatchObject({ payment_method_token: 'pmt_saved' });
      expect(confirms[0].context?.paymentMethodId).toBe('pm_saved');
    });

    it('saves a new card on completion when the shopper ticked “save”', async () => {
      session.customerId = 'cus_1';
      session.savePaymentMethod = 'optional';
      await service().confirm(SECRET_PRINCIPAL, 'cs_1', { payment_method_token: 'pmt_new_card_token', save_payment_method: true });

      expect(session.saveCardRequested).toBe(true);
      expect(attached).toHaveLength(1);
      expect(defaults).toEqual([{ customerId: 'cus_1', pmId: 'pm_new', onlyIfUnset: true }]);
      expect(session.status).toBe('complete');
    });

    it('does not save a card the shopper did not ask to save', async () => {
      session.customerId = 'cus_1';
      session.savePaymentMethod = 'optional';
      await service().confirm(SECRET_PRINCIPAL, 'cs_1', { payment_method_token: 'pmt_new_card_token' });
      expect(attached).toHaveLength(0);
    });
  });

  describe('subscription completion', () => {
    it('saves the card and starts the subscription in the completing commit', async () => {
      session.mode = 'subscription';
      session.priceId = 'price_1';
      session.customerId = 'cus_1';
      intent.status = 'succeeded';
      intent.payment_method_token = 'pmt_new_card_token';

      const view = await service().getPublic(SECRET_PRINCIPAL, 'cs_1');

      expect(view.status).toBe('complete');
      expect(view.recurring).toEqual({ interval: 'month', interval_count: 1 });
      expect(attached).toHaveLength(1);
      expect(started[0]).toMatchObject({ customer: { id: 'cus_1' }, paymentMethod: { id: 'pm_new' } });
      expect(session.subscriptionId).toBe('csub_new');
    });

    it('keeps a held payment’s session open: a review is not a payment', async () => {
      intent.status = 'requires_capture';
      intent.review_id = 'rv_1';
      expect((await service().getPublic(SECRET_PRINCIPAL, 'cs_1')).status).toBe('open');
    });
  });

  describe('setup mode', () => {
    beforeEach(() => {
      session.mode = 'setup';
      session.amountMinor = 0;
      session.customerId = 'cus_1';
      session.subscriptionId = 'csub_1';
      intent.amount_minor = 0;
      intent.status = 'requires_payment_method';
    });

    it('saves the card as the customer’s and the subscription’s, completes, and retries the renewal', async () => {
      const view = await service().confirm(SECRET_PRINCIPAL, 'cs_1', { payment_method_token: 'pmt_new_card_token' });

      expect(confirms).toHaveLength(0); // nothing is charged
      expect(attached).toHaveLength(1);
      expect(defaults).toEqual([{ customerId: 'cus_1', pmId: 'pm_new', onlyIfUnset: false }]);
      expect(subscriptionCards).toEqual([{ id: 'csub_1', pm: 'pm_new' }]);
      expect(retried).toEqual(['csub_1']);
      expect(view.status).toBe('complete');
    });

    it('needs a card', async () => {
      await expect(service().confirm(SECRET_PRINCIPAL, 'cs_1', {})).rejects.toBeInstanceOf(ValidationException);
    });
  });
});

function dto(fields: Partial<CreateCheckoutSessionDto>): CreateCheckoutSessionDto {
  return stub<CreateCheckoutSessionDto>(fields);
}

function customer(): CustomerEntity {
  return Object.assign(new CustomerEntity(), { id: 'cus_1', email: 'shopper@example.com', defaultPaymentMethodId: null });
}

function price(): PriceEntity {
  return Object.assign(new PriceEntity(), {
    id: 'price_1',
    productName: 'Monthly Subscription',
    unitAmountMinor: 3_800,
    currency: 'USD',
    recurringInterval: 'month',
    recurringIntervalCount: 1,
    active: true,
  });
}

function sessionRow(): CheckoutSessionEntity {
  return Object.assign(new CheckoutSessionEntity(), {
    id: 'cs_1',
    merchantId: 'mch_1',
    livemode: false,
    paymentIntentId: 'pi_1',
    status: 'open',
    uiMode: 'hosted',
    mode: 'payment',
    amountMinor: 3_800,
    currency: 'USD',
    description: null,
    lineItems: [],
    customerReference: null,
    customerEmail: null,
    customerId: null,
    priceId: null,
    subscriptionId: null,
    savePaymentMethod: 'never',
    adaptivePricing: true,
    saveCardRequested: false,
    successUrl: 'http://shop.localhost/thanks',
    cancelUrl: null,
    allowedOrigin: null,
    clientSecret: 'cs_1_secret_x',
    metadata: {},
    expiresAt: new Date('2026-10-30T09:00:00.000Z'),
    completedAt: null,
    createdAt: new Date('2026-10-29T09:00:00.000Z'),
    updatedAt: new Date('2026-10-29T09:00:00.000Z'),
  });
}

function intentRow(): PaymentIntentEntity {
  return Object.assign(new PaymentIntentEntity(), {
    id: 'pi_1',
    merchantId: 'mch_1',
    livemode: false,
    amount_minor: 3_800,
    currency: 'USD',
    status: 'requires_payment_method',
    payment_method_token: null,
    payment_method_id: null,
    latest_charge_id: null,
    client_secret: 'pi_1_secret_x',
    next_action: null,
    presentment: null,
    review_id: null,
    metadata: {},
  });
}
