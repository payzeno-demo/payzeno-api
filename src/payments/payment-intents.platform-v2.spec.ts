import type { EntityManager } from 'typeorm';

import { ConflictException } from 'src/common/errors/api.exception';
import { MerchantNotActivatedException } from 'src/common/errors/business.exceptions';
import type { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import { MerchantEntity } from 'src/merchants/merchant.entity';
import type { MerchantsService } from 'src/merchants/merchants.service';
import type { CancelPaymentFlow } from 'src/payments/flows/cancel-payment.flow';
import type { CapturePaymentFlow } from 'src/payments/flows/capture-payment.flow';
import type { ConfirmPaymentFlow } from 'src/payments/flows/confirm-payment.flow';
import { PaymentIntentEntity } from 'src/payments/payment-intent.entity';
import type { PaymentIntentRepository } from 'src/payments/payment-intent.repository';
import { PaymentIntentsService, toPaymentIntent } from 'src/payments/payment-intents.service';
import { ReviewEntity } from 'src/risk/review.entity';
import type { ReviewRepository } from 'src/risk/review.repository';
import { FixedClock } from 'test/support/fixed-clock';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

const MERCHANT_ID = 'mch_01JBMERCHANT0000000000000A';

/**
 * RFC platform-v2 on PaymentIntentsService: the live gate (§3), the §5–§8 fields on the wire,
 * and the refusal to let a merchant capture a payment Payzeno risk is still reviewing.
 */
describe('PaymentIntentsService (platform-v2)', () => {
  let merchant: MerchantEntity;
  let inserted: Array<Partial<PaymentIntentEntity>>;
  let reviews: ReviewRepository;
  let capture: jest.Mock;

  function service(): PaymentIntentsService {
    return new PaymentIntentsService(
      stub<PaymentIntentRepository>({
        insertIntent: jest.fn(async (_manager: EntityManager, row: Partial<PaymentIntentEntity>) => {
          inserted.push(row);
          return Object.assign(new PaymentIntentEntity(), row);
        }),
        findScoped: jest.fn(async () => intentRow({ review_id: 'rv_1', status: 'requires_capture' })),
      }),
      stub<ConfirmPaymentFlow>({}),
      stub<CapturePaymentFlow>({ execute: capture }),
      stub<CancelPaymentFlow>({}),
      stub<MerchantsService>({ getById: jest.fn(async () => merchant) }),
      reviews,
      stub<TransactionManager>({
        runInTransaction: jest.fn(async <T>(fn: (m: EntityManager) => Promise<T>) => fn(stub<EntityManager>({}))),
      }),
      stub<IdFactory>({ paymentIntentId: () => 'pi_01JBINTENT00000000000000AA' }),
      new FixedClock('2026-10-29T09:00:00.000Z'),
      new NoopLogger(),
    );
  }

  beforeEach(() => {
    merchant = Object.assign(new MerchantEntity(), { id: MERCHANT_ID, status: 'pending_review' });
    inserted = [];
    capture = jest.fn();
    reviews = stub<ReviewRepository>({
      findOne: jest.fn(async () => Object.assign(new ReviewEntity(), { id: 'rv_1', status: 'open' })),
    });
  });

  describe('live gate', () => {
    const input = { amount_minor: 3_800, currency: 'USD' as const };

    it('refuses a live intent for a merchant that is not activated', async () => {
      await expect(
        service().createInternal({ merchantId: MERCHANT_ID, livemode: true }, input),
      ).rejects.toBeInstanceOf(MerchantNotActivatedException);
      expect(inserted).toHaveLength(0);
    });

    it('answers 403 merchant_not_activated', () => {
      const err = new MerchantNotActivatedException(MERCHANT_ID, 'pending_review');
      expect(err.httpStatus).toBe(403);
      expect(err.code).toBe('merchant_not_activated');
    });

    it('always allows test mode', async () => {
      await service().createInternal({ merchantId: MERCHANT_ID, livemode: false }, input);
      expect(inserted).toHaveLength(1);
    });

    it('allows live mode once active, and while restricted (restricted only may not be paid out)', async () => {
      merchant.status = 'active';
      await service().createInternal({ merchantId: MERCHANT_ID, livemode: true }, input);
      merchant.status = 'restricted';
      await service().createInternal({ merchantId: MERCHANT_ID, livemode: true }, input);
      expect(inserted).toHaveLength(2);
    });
  });

  it('persists the internal callers’ fields on the new intent', async () => {
    await service().createInternal(
      { merchantId: MERCHANT_ID, livemode: false },
      {
        amount_minor: 3_800,
        currency: 'USD',
        customer_id: 'cus_1',
        payment_method_id: 'pm_1',
        receipt_email: 'shopper@example.com',
        subscription_id: 'csub_1',
        payment_method_token: 'pmt_0123456789abcdef',
      },
    );
    expect(inserted[0]).toMatchObject({
      status: 'requires_confirmation',
      customer_id: 'cus_1',
      payment_method_id: 'pm_1',
      receipt_email: 'shopper@example.com',
      subscription_id: 'csub_1',
      presentment: null,
      review_id: null,
    });
  });

  it('refuses a merchant capture while a review is open', async () => {
    const principal = { kind: 'api_key' as const, merchant_id: MERCHANT_ID, api_key_id: 'key_1', mode: 'live' as const, scopes: [] };
    await expect(service().capture(principal, 'pi_1', {})).rejects.toBeInstanceOf(ConflictException);
    expect(capture).not.toHaveBeenCalled();
  });

  describe('toPaymentIntent', () => {
    it('carries the platform-v2 fields and never the vault token', () => {
      const wire = toPaymentIntent(
        intentRow({
          payment_method_token: 'pmt_secret_reusable_token',
          customer_id: 'cus_1',
          payment_method_id: 'pm_1',
          receipt_email: 'shopper@example.com',
          presentment: { original_amount_minor: 3_800, original_currency: 'USD', fx_rate: '0.941562', fx_quote_id: 'fxq_1' },
          review_id: 'rv_1',
          subscription_id: 'csub_1',
        }),
      );

      expect(wire).toMatchObject({
        customer_id: 'cus_1',
        payment_method_id: 'pm_1',
        receipt_email: 'shopper@example.com',
        presentment: { original_currency: 'USD', fx_quote_id: 'fxq_1' },
        review_id: 'rv_1',
        subscription_id: 'csub_1',
      });
      expect(JSON.stringify(wire)).not.toContain('pmt_');
    });
  });
});

function intentRow(overrides: Partial<PaymentIntentEntity>): PaymentIntentEntity {
  return Object.assign(new PaymentIntentEntity(), {
    id: 'pi_1',
    merchantId: MERCHANT_ID,
    livemode: true,
    amount_minor: 3_578,
    currency: 'EUR',
    status: 'succeeded',
    capture_method: 'automatic',
    payment_method_token: null,
    customer_reference: null,
    description: null,
    statement_descriptor: null,
    latest_charge_id: null,
    client_secret: 'pi_1_secret_x',
    next_action: null,
    metadata: {},
    canceled_at: null,
    cancellation_reason: null,
    customer_id: null,
    payment_method_id: null,
    receipt_email: null,
    presentment: null,
    review_id: null,
    subscription_id: null,
    createdAt: new Date('2026-10-29T09:00:00.000Z'),
    updatedAt: new Date('2026-10-29T09:00:00.000Z'),
    ...overrides,
  });
}
