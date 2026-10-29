import type { EntityManager } from 'typeorm';

import { PriceEntity } from 'src/billing/recurring/price.entity';
import type { PriceRepository } from 'src/billing/recurring/price.repository';
import type { NoticeSubject, SubscriptionNotices } from 'src/billing/recurring/subscription-notices';
import { SubscriptionRenewalService } from 'src/billing/recurring/subscription-renewal.service';
import { SubscriptionEntity } from 'src/billing/recurring/subscription.entity';
import type { SubscriptionPatch, SubscriptionRepository } from 'src/billing/recurring/subscription.repository';
import type { SubscriptionsService } from 'src/billing/recurring/subscriptions.service';
import type { CheckoutSessionsService } from 'src/checkout/checkout-sessions.service';
import { CardDeclinedException } from 'src/common/errors/card.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import { CustomerEntity } from 'src/customers/customer.entity';
import type { CustomersService } from 'src/customers/customers.service';
import { MerchantEntity } from 'src/merchants/merchant.entity';
import type { MerchantsService } from 'src/merchants/merchants.service';
import { PaymentMethodEntity } from 'src/payment-methods/payment-method.entity';
import type { PaymentMethodsService } from 'src/payment-methods/payment-methods.service';
import type { ConfirmContext } from 'src/payments/flows/confirm-payment.flow';
import { PaymentIntentEntity } from 'src/payments/payment-intent.entity';
import type { InternalIntentInput, PaymentIntentsService } from 'src/payments/payment-intents.service';
import { FixedClock } from 'test/support/fixed-clock';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

const MANAGER = stub<EntityManager>({});
const DAY = 86_400_000;

/**
 * The renewal state machine against an in-memory subscription row: success advances the
 * period, failures walk +1d/+3d/+7d and then cancel, a jumped clock is caught up, and a forced
 * retry from a setup session does not consume a scheduled retry.
 */
describe('SubscriptionRenewalService', () => {
  let clock: FixedClock;
  let row: SubscriptionEntity;
  let intents: Map<string, PaymentIntentEntity>;
  let nextOutcome: Array<'succeeded' | 'declined'>;
  let notices: Array<{ kind: string; updateUrl?: string; nextRetry?: Date | null; periodEnd?: string }>;
  let canceled: string[];
  let setupLinks: number;
  let created: InternalIntentInput[];

  function service(): SubscriptionRenewalService {
    const repo = stub<SubscriptionRepository>({
      findOne: jest.fn(async () => clone(row)),
      findDue: jest.fn(async () => [clone(row)]),
      lockSubscription: jest.fn(async () => clone(row)),
      patch: jest.fn(async (_m: EntityManager, _id: string, patch: SubscriptionPatch) => {
        Object.assign(row, patch);
      }),
    });

    return new SubscriptionRenewalService(
      repo,
      stub<SubscriptionsService>({
        cancelNow: jest.fn(async (_m: EntityManager, locked: SubscriptionEntity) => {
          row.status = 'canceled';
          row.canceledAt = clock.now();
          row.nextRetryAt = null;
          canceled.push(locked.id);
        }),
      }),
      stub<PriceRepository>({ findById: jest.fn(async () => price()) }),
      stub<CustomersService>({ requireInScope: jest.fn(async () => customer()) }),
      stub<PaymentMethodsService>({ findUsable: jest.fn(async () => card()) }),
      stub<PaymentIntentsService>({
        createInternal: jest.fn(async (_scope, input: InternalIntentInput) => {
          created.push(input);
          const intent = Object.assign(new PaymentIntentEntity(), {
            id: `pi_${created.length}`,
            status: 'requires_confirmation',
            metadata: input.metadata ?? {},
            subscription_id: input.subscription_id ?? null,
          });
          intents.set(intent.id, intent);
          return intent;
        }),
        confirmInScope: jest.fn(async (_scope, id: string, _req, context?: ConfirmContext) => {
          expect(context?.offSession).toBe(true);
          const intent = intents.get(id) as PaymentIntentEntity;
          const outcome = nextOutcome.shift() ?? 'succeeded';
          intent.status = outcome === 'succeeded' ? 'succeeded' : 'requires_payment_method';
          if (outcome === 'declined') throw new CardDeclinedException('insufficient_funds');
          return intent;
        }),
        requireInScope: jest.fn(async (_scope, id: string) => intents.get(id) as PaymentIntentEntity),
        cancelInScope: jest.fn(),
      }),
      stub<MerchantsService>({
        getById: jest.fn(async () => Object.assign(new MerchantEntity(), { displayName: 'Northwind Coffee Roasters' })),
      }),
      stub<SubscriptionNotices>({
        renewed: jest.fn(async (_m: EntityManager, subject: NoticeSubject) => {
          notices.push({ kind: 'renewed', periodEnd: subject.subscription.currentPeriodEnd.toISOString() });
        }),
        paymentFailed: jest.fn(async (_m: EntityManager, _s: NoticeSubject, updateUrl: string, nextRetry: Date | null) => {
          notices.push({ kind: 'payment_failed', updateUrl, nextRetry });
        }),
      }),
      stub<TransactionManager>({ runInTransaction: jest.fn(async <T>(fn: (m: EntityManager) => Promise<T>) => fn(MANAGER)) }),
      stub<CheckoutSessionsService>({
        createRenewalSetupSession: jest.fn(async () => {
          setupLinks += 1;
          return `http://pay.localhost/c/cs_${setupLinks}#cs_${setupLinks}_secret_x`;
        }),
      }),
      clock,
      new NoopLogger(),
    );
  }

  beforeEach(() => {
    clock = new FixedClock('2026-11-29T09:00:00.000Z');
    row = Object.assign(new SubscriptionEntity(), {
      id: 'csub_1',
      merchantId: 'mch_1',
      livemode: false,
      customerId: 'cus_1',
      priceId: 'price_1',
      status: 'active',
      currentPeriodStart: new Date('2026-10-29T09:00:00.000Z'),
      currentPeriodEnd: new Date('2026-11-29T09:00:00.000Z'),
      cancelAtPeriodEnd: false,
      canceledAt: null,
      defaultPaymentMethodId: 'pm_1',
      latestPaymentIntentId: null,
      nextRetryAt: null,
      failedAttempts: 0,
      pastDueSince: null,
      metadata: {},
      createdAt: new Date('2026-10-29T09:00:00.000Z'),
    });
    intents = new Map();
    nextOutcome = [];
    notices = [];
    canceled = [];
    setupLinks = 0;
    created = [];
  });

  it('charges a due subscription off-session and advances the period', async () => {
    const counts = await service().renewDue(10);

    expect(counts.renewed).toBe(1);
    expect(created[0]).toMatchObject({
      amount_minor: 3_800,
      currency: 'USD',
      subscription_id: 'csub_1',
      payment_method_id: 'pm_1',
      receipt_email: 'shopper@example.com',
      metadata: { subscription_id: 'csub_1', subscription_period_end: '2026-11-29T09:00:00.000Z' },
    });
    expect(row.currentPeriodStart.toISOString()).toBe('2026-11-29T09:00:00.000Z');
    expect(row.currentPeriodEnd.toISOString()).toBe('2026-12-29T09:00:00.000Z');
    expect(notices).toEqual([{ kind: 'renewed', periodEnd: '2026-12-29T09:00:00.000Z' }]);
  });

  it('leaves a subscription alone before its period ends', async () => {
    clock = new FixedClock('2026-11-29T08:59:59.000Z');
    expect(await service().retryNow('csub_1')).toBe('skipped');
    expect(created).toHaveLength(0);
  });

  it('catches up every period a jumped clock skipped, one charge each', async () => {
    clock = new FixedClock('2027-02-01T00:00:00.000Z');
    const counts = await service().renewDue(10);

    expect(counts.renewed).toBe(3);
    expect(created.map((input) => input.metadata?.subscription_period_end)).toEqual([
      '2026-11-29T09:00:00.000Z',
      '2026-12-29T09:00:00.000Z',
      '2027-01-29T09:00:00.000Z',
    ]);
    expect(row.currentPeriodEnd.toISOString()).toBe('2027-02-28T09:00:00.000Z');
  });

  it('goes past due on a decline, with a fresh update link and the +1d retry', async () => {
    nextOutcome = ['declined'];
    await service().renewDue(10);

    expect(row.status).toBe('past_due');
    expect(row.failedAttempts).toBe(1);
    expect(row.pastDueSince?.toISOString()).toBe('2026-11-29T09:00:00.000Z');
    expect(row.nextRetryAt?.toISOString()).toBe('2026-11-30T09:00:00.000Z');
    expect(notices).toEqual([
      { kind: 'payment_failed', updateUrl: 'http://pay.localhost/c/cs_1#cs_1_secret_x', nextRetry: row.nextRetryAt },
    ]);
  });

  it('retries at +1d, +3d, +7d from the first failure, then cancels', async () => {
    nextOutcome = ['declined', 'declined', 'declined', 'declined'];
    const renewals = service();

    await renewals.renewDue(10); // first failure
    for (const [day, retry] of [[1, '2026-12-02'], [3, '2026-12-06']] as const) {
      clock.advanceMs(day === 1 ? DAY : 2 * DAY);
      await renewals.renewDue(10);
      expect(row.nextRetryAt?.toISOString().slice(0, 10)).toBe(retry);
    }
    clock.advanceMs(4 * DAY); // +7d
    await renewals.renewDue(10);

    expect(row.status).toBe('canceled');
    expect(canceled).toEqual(['csub_1']);
    expect(notices.filter((n) => n.kind === 'payment_failed')).toHaveLength(3);
    expect(setupLinks).toBe(3);
  });

  it('retries the same period’s intent rather than minting a new one per attempt', async () => {
    nextOutcome = ['declined', 'succeeded'];
    const renewals = service();
    await renewals.renewDue(10);
    clock.advanceMs(DAY);
    await renewals.renewDue(10);

    expect(created).toHaveLength(1);
    expect(row.status).toBe('active');
    expect(row.failedAttempts).toBe(0);
    expect(row.currentPeriodEnd.toISOString()).toBe('2026-12-29T09:00:00.000Z');
  });

  it('a setup session’s forced retry does not consume a scheduled retry when it fails', async () => {
    nextOutcome = ['declined', 'declined'];
    const renewals = service();
    await renewals.renewDue(10);
    const scheduled = row.nextRetryAt;

    expect(await renewals.retryNow('csub_1')).toBe('failed');
    expect(row.failedAttempts).toBe(1);
    expect(row.nextRetryAt).toEqual(scheduled);
  });

  it('a setup session’s forced retry renews a past-due subscription at once', async () => {
    nextOutcome = ['declined', 'succeeded'];
    const renewals = service();
    await renewals.renewDue(10);

    expect(await renewals.retryNow('csub_1')).toBe('renewed');
    expect(row.status).toBe('active');
  });

  it('ends a subscription set to cancel at period end, without charging', async () => {
    row.cancelAtPeriodEnd = true;
    const counts = await service().renewDue(10);

    expect(counts.canceled).toBe(1);
    expect(row.status).toBe('canceled');
    expect(created).toHaveLength(0);
  });
});

function clone(row: SubscriptionEntity): SubscriptionEntity {
  return Object.assign(new SubscriptionEntity(), row);
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

function customer(): CustomerEntity {
  return Object.assign(new CustomerEntity(), { id: 'cus_1', email: 'shopper@example.com', defaultPaymentMethodId: 'pm_1' });
}

function card(): PaymentMethodEntity {
  return Object.assign(new PaymentMethodEntity(), { id: 'pm_1', customerId: 'cus_1', vaultToken: 'pmt_saved' });
}
