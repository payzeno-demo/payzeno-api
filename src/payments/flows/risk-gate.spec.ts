import type { Merchant } from '@payzeno/contracts';
import type { EntityManager } from 'typeorm';

import { CardDeclinedException } from 'src/common/errors/card.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { ApiConfig } from 'src/config/api-config.type';
import type { EventPublisher } from 'src/events/publisher';
import type { LedgerReadThroughService } from 'src/ledger/ledger-read-through.service';
import { MerchantUserEntity } from 'src/merchants/users/merchant-user.entity';
import type { MerchantUserRepository } from 'src/merchants/users/merchant-user.repository';
import type { EmailService, QueueEmailInput } from 'src/notifications/email/email.service';
import { ChargeEntity } from 'src/payments/charge.entity';
import type { ChargeRepository } from 'src/payments/charge.repository';
import { BLOCKED_MESSAGE, RiskGate } from 'src/payments/flows/risk-gate';
import { PaymentIntentEntity } from 'src/payments/payment-intent.entity';
import type { PaymentIntentRepository } from 'src/payments/payment-intent.repository';
import type { ProcessorAdapter } from 'src/payments/processor/processor.adapter';
import type { ProcessorRouter } from 'src/payments/processor/processor.router';
import { PaymentIntentStateMachine } from 'src/payments/state/payment-intent.state-machine';
import type { ReviewEntity } from 'src/risk/review.entity';
import type { ReviewRepository } from 'src/risk/review.repository';
import type { RiskAssessment } from 'src/risk/risk-engine.service';
import { FixedClock } from 'test/support/fixed-clock';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

const MANAGER = stub<EntityManager>({});

const ASSESSMENT: RiskAssessment = {
  outcome: 'review',
  rules: ['country_mismatch'],
  signals: {
    acquirerScore: 12,
    amountMinor: 30_000,
    currency: 'USD',
    ipCountry: 'JP',
    cardCountry: 'GB',
    cardAttemptsLastHour: 0,
    cardFailuresLastHour: 0,
    ipDistinctCardsLastHour: 1,
    merchantAverageMinor: null,
    merchantSampleSize: 0,
    merchantAgeDays: 3,
  },
};

describe('RiskGate', () => {
  let voidCall: jest.Mock;
  let markBlocked: jest.Mock;
  let transition: jest.Mock;
  let published: Array<{ type: string; payload: Record<string, unknown> }>;
  let release: jest.Mock;
  let insertedReviews: ReviewEntity[];
  let emails: QueueEmailInput[];

  function gate(): RiskGate {
    return new RiskGate(
      stub<PaymentIntentRepository>({ transitionStatus: transition }),
      new PaymentIntentStateMachine(),
      stub<ChargeRepository>({ markBlocked }),
      stub<ProcessorRouter>({ forAcquirer: () => stub<ProcessorAdapter>({ void: voidCall }) }),
      stub<LedgerReadThroughService>({ releaseAuthorization: release }),
      stub<ReviewRepository>({
        insertReview: jest.fn(async (_m: EntityManager, row: ReviewEntity) => {
          insertedReviews.push(row);
          return row;
        }),
      }),
      stub<MerchantUserRepository>({
        listForMerchant: jest.fn(async () => [
          user('owner@shop.example', 'owner', 'active'),
          user('admin@shop.example', 'admin', 'active'),
          user('dev@shop.example', 'developer', 'active'),
          user('gone@shop.example', 'admin', 'disabled'),
        ]),
      }),
      stub<EmailService>({
        queue: jest.fn(async (input: QueueEmailInput) => {
          emails.push(input);
        }),
      }),
      stub<TransactionManager>({ runInTransaction: jest.fn(async <T>(fn: (m: EntityManager) => Promise<T>) => fn(MANAGER)) }),
      stub<EventPublisher>({
        publish: jest.fn(async (type: string, payload: Record<string, unknown>) => {
          published.push({ type, payload });
          return 'evt_1';
        }),
      }),
      stub<ApiConfig>({ publicUrls: { console: 'http://localhost', admin: null } }),
      new FixedClock('2026-10-29T09:00:00.000Z'),
      new NoopLogger(),
    );
  }

  beforeEach(() => {
    voidCall = jest.fn().mockResolvedValue({ voided: true, processorReference: 'WFT1' });
    markBlocked = jest.fn().mockResolvedValue(1);
    transition = jest.fn().mockResolvedValue(1);
    release = jest.fn().mockResolvedValue({});
    published = [];
    insertedReviews = [];
    emails = [];
  });

  describe('block', () => {
    it('voids the approval, lands the intent as a decline and releases the ledger hold', async () => {
      const intent = intent_();
      await expect(gate().block(intent, charge(), { ...ASSESSMENT, outcome: 'block' })).rejects.toMatchObject({
        declineCode: 'fraud_suspected',
      });

      expect(voidCall).toHaveBeenCalledWith(expect.objectContaining({ networkTransactionId: 'WFT1' }));
      expect(markBlocked).toHaveBeenCalledWith(MANAGER, 'ch_1', true, BLOCKED_MESSAGE);
      expect(transition).toHaveBeenCalledWith(MANAGER, 'pi_1', 'processing', 'requires_payment_method', {
        latest_charge_id: 'ch_1',
        next_action: null,
      });
      expect(published).toEqual([
        expect.objectContaining({
          type: 'payment.failed',
          payload: expect.objectContaining({ failure_code: 'fraud_suspected', retryable: false }),
        }),
      ]);
      expect(release).toHaveBeenCalledWith(expect.objectContaining({ chargeId: 'ch_1', amountMinor: 30_000 }));
      expect(intent.status).toBe('requires_payment_method');
    });

    it('is a CardDeclinedException to the caller — to a shopper a block is a decline', async () => {
      await expect(gate().block(intent_(), charge(), ASSESSMENT)).rejects.toBeInstanceOf(CardDeclinedException);
    });

    it('keeps the charge authorised for the expiry job when the acquirer would not void', async () => {
      voidCall.mockRejectedValue(new Error('acquirer down'));
      await expect(gate().block(intent_(), charge(), ASSESSMENT)).rejects.toBeInstanceOf(CardDeclinedException);

      expect(markBlocked).toHaveBeenCalledWith(MANAGER, 'ch_1', false, BLOCKED_MESSAGE);
      expect(release).not.toHaveBeenCalled();
    });

    it('tags a subscription payment’s failure with the subscription', async () => {
      await expect(gate().block(intent_({ subscription_id: 'csub_1' }), charge(), ASSESSMENT)).rejects.toThrow();
      expect(published[0].payload.subscription_id).toBe('csub_1');
    });
  });

  describe('openReview', () => {
    it('records the review with the shopper and card countries', async () => {
      await gate().openReview(MANAGER, intent_(), charge(), merchant(), ASSESSMENT, 'rv_1');

      expect(insertedReviews[0]).toMatchObject({
        id: 'rv_1',
        status: 'open',
        paymentIntentId: 'pi_1',
        chargeId: 'ch_1',
        rules: ['country_mismatch'],
        ipCountry: 'JP',
        cardCountry: 'GB',
        amountMinor: 30_000,
      });
    });

    it('emails the merchant’s active owners and admins, nobody else', async () => {
      await gate().openReview(MANAGER, intent_(), charge(), merchant(), ASSESSMENT, 'rv_1');

      expect(emails.map((e) => e.to)).toEqual(['owner@shop.example', 'admin@shop.example']);
      expect(emails[0]).toMatchObject({
        template: 'payment_review_opened',
        data: {
          merchant_name: 'Northwind Coffee Roasters',
          amount: '$300.00',
          payment_id: 'pi_1',
          console_url: 'http://localhost/payments/pi_1',
        },
      });
    });
  });
});

function user(email: string, role: MerchantUserEntity['role'], status: MerchantUserEntity['status']): MerchantUserEntity {
  return Object.assign(new MerchantUserEntity(), { email, role, status });
}

function merchant(): Merchant {
  return stub<Merchant>({ id: 'mch_1', display_name: 'Northwind Coffee Roasters' });
}

function intent_(overrides: Partial<PaymentIntentEntity> = {}): PaymentIntentEntity {
  return Object.assign(new PaymentIntentEntity(), {
    id: 'pi_1',
    merchantId: 'mch_1',
    livemode: true,
    status: 'processing',
    subscription_id: null,
    ...overrides,
  });
}

function charge(): ChargeEntity {
  return Object.assign(new ChargeEntity(), {
    id: 'ch_1',
    merchantId: 'mch_1',
    livemode: true,
    amount_minor: 30_000,
    currency: 'USD',
    acquirer: 'worldflow',
    network_transaction_id: 'WFT1',
    risk_score: 12,
    card_country: 'GB',
    shopper_country: 'JP',
  });
}
