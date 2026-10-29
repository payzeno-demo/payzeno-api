import type { AuthPrincipal } from '@payzeno/contracts';
import type { EntityManager } from 'typeorm';

import { ConflictException } from 'src/common/errors/api.exception';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import { MerchantEntity } from 'src/merchants/merchant.entity';
import type { MerchantsService } from 'src/merchants/merchants.service';
import type { EmailService, QueueEmailInput } from 'src/notifications/email/email.service';
import type { CancelPaymentFlow } from 'src/payments/flows/cancel-payment.flow';
import type { CapturePaymentFlow } from 'src/payments/flows/capture-payment.flow';
import { PaymentIntentEntity } from 'src/payments/payment-intent.entity';
import type { PaymentIntentsService } from 'src/payments/payment-intents.service';
import { ReviewEntity } from 'src/risk/review.entity';
import type { ReviewRepository } from 'src/risk/review.repository';
import { ReviewsService } from 'src/risk/reviews.service';
import { FixedClock } from 'test/support/fixed-clock';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

const STAFF: AuthPrincipal = { kind: 'staff_session', staff_id: 'stf_risk_1', role: 'risk', acting_merchant_id: null };

describe('ReviewsService', () => {
  let review: ReviewEntity;
  let intent: PaymentIntentEntity;
  let capture: jest.Mock;
  let cancel: jest.Mock;
  let closed: Array<Record<string, unknown>>;
  let emails: QueueEmailInput[];
  let closeAffected: number;

  function service(): ReviewsService {
    return new ReviewsService(
      stub<ReviewRepository>({
        findById: jest.fn(async () => review),
        close: jest.fn(async (_m: EntityManager, _id: string, decision: Record<string, unknown>) => {
          closed.push(decision);
          return closeAffected;
        }),
      }),
      stub<PaymentIntentsService>({ requireInScope: jest.fn(async () => intent) }),
      stub<CapturePaymentFlow>({ execute: capture }),
      stub<CancelPaymentFlow>({ execute: cancel }),
      stub<MerchantsService>({ getById: jest.fn(async () => Object.assign(new MerchantEntity(), { displayName: 'Northwind' })) }),
      stub<EmailService>({
        queue: jest.fn(async (input: QueueEmailInput) => {
          emails.push(input);
        }),
      }),
      stub<TransactionManager>({ runInTransaction: jest.fn(async <T>(fn: (m: EntityManager) => Promise<T>) => fn(stub<EntityManager>({}))) }),
      new FixedClock('2026-10-29T10:00:00.000Z'),
      new NoopLogger(),
    );
  }

  beforeEach(() => {
    review = Object.assign(new ReviewEntity(), {
      id: 'rv_1',
      merchantId: 'mch_1',
      livemode: true,
      paymentIntentId: 'pi_1',
      chargeId: 'ch_1',
      status: 'open',
      rules: ['country_mismatch'],
      riskScore: 12,
      amountMinor: 30_000,
      currency: 'USD',
      ipCountry: 'JP',
      cardCountry: 'GB',
      openedAt: new Date('2026-10-29T09:00:00.000Z'),
      closedAt: null,
      closedBy: null,
      note: null,
    });
    intent = Object.assign(new PaymentIntentEntity(), {
      id: 'pi_1',
      status: 'requires_capture',
      receipt_email: 'shopper@example.com',
    });
    capture = jest.fn();
    cancel = jest.fn();
    closed = [];
    emails = [];
    closeAffected = 1;
  });

  it('approve captures the held payment, then closes the review as the analyst', async () => {
    const result = await service().approve(STAFF, 'rv_1', { note: 'known customer' });

    expect(capture).toHaveBeenCalledWith(intent, {});
    expect(closed[0]).toMatchObject({ status: 'approved', closedBy: 'stf_risk_1', note: 'known customer' });
    expect(result).toMatchObject({ status: 'approved', closed_by: 'stf_risk_1', closed_at: '2026-10-29T10:00:00.000Z' });
    expect(emails).toHaveLength(0); // the receipt comes from the capture commit
  });

  it('approve finishes a decision whose capture already happened', async () => {
    intent.status = 'succeeded';
    await service().approve(STAFF, 'rv_1', {});
    expect(capture).not.toHaveBeenCalled();
    expect(closed[0]).toMatchObject({ status: 'approved' });
  });

  it('decline voids the payment as fraudulent and tells the shopper', async () => {
    await service().decline(STAFF, 'rv_1', {});

    expect(cancel).toHaveBeenCalledWith(intent, { cancellation_reason: 'fraudulent' });
    expect(closed[0]).toMatchObject({ status: 'declined' });
    expect(emails).toEqual([
      expect.objectContaining({
        template: 'payment_declined_after_review',
        to: 'shopper@example.com',
        data: { merchant_name: 'Northwind', amount: '$300.00' },
      }),
    ]);
  });

  it('refuses to decide a closed review', async () => {
    review.status = 'approved';
    await expect(service().decline(STAFF, 'rv_1', {})).rejects.toBeInstanceOf(ConflictException);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('loses a race to another analyst with a 409, not a second decision', async () => {
    closeAffected = 0;
    await expect(service().approve(STAFF, 'rv_1', {})).rejects.toBeInstanceOf(ConflictException);
  });

  it('cannot decline a payment that was already captured', async () => {
    intent.status = 'succeeded';
    await expect(service().decline(STAFF, 'rv_1', {})).rejects.toBeInstanceOf(ConflictException);
  });
});
