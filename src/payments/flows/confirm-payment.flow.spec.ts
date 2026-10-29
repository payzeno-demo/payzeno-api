import { Test } from '@nestjs/testing';

import { NoopLogger, PAYZENO_LOGGER } from 'src/common/logging/logger';
import { TransactionManager } from 'src/common/persistence/transaction.manager';
import { ChargeAuthorizationService } from 'src/payments/charge-authorization.service';
import { ConfirmPaymentFlow } from 'src/payments/flows/confirm-payment.flow';
import type { RiskGate } from 'src/payments/flows/risk-gate';
import { MerchantsService } from 'src/merchants/merchants.service';
import { PaymentIntentRepository } from 'src/payments/payment-intent.repository';
import { PaymentIntentStateMachine } from 'src/payments/state/payment-intent.state-machine';

import { InsufficientFundsException } from 'src/common/errors/card.exceptions';
import type { ApiConfig } from 'src/config/api-config.type';
import { MerchantEntity } from 'src/merchants/merchant.entity';
import type { ChargeCaptureService } from 'src/payments/charge-capture.service';
import { ChargeEntity } from 'src/payments/charge.entity';
import type { ChargeRepository } from 'src/payments/charge.repository';
import { PaymentIntentEntity } from 'src/payments/payment-intent.entity';

import { makeCharge } from 'test/factories/charge.factory';
import { makeMerchant } from 'test/factories/merchant.factory';
import { makePaymentIntent } from 'test/factories/payment-intent.factory';

/**
 * Chain F of the blueprint: confirm → FSM → authorize → vault → router → acquirer, with
 * the SCA branch landing back on the FSM as `require_action`.
 *
 * The flow owns the transaction boundary and the state transitions; it owns no payment
 * logic. That split is what stops `PaymentIntentsService` becoming 900 lines.
 */
describe('ConfirmPaymentFlow', () => {
  let flow: ConfirmPaymentFlow;
  let auth: jest.Mocked<ChargeAuthorizationService>;
  let repo: jest.Mocked<PaymentIntentRepository>;
  let merchants: jest.Mocked<MerchantsService>;

  beforeEach(async () => {
    auth = { authorize: jest.fn().mockResolvedValue(makeCharge({ status: 'captured' })) } as unknown as jest.Mocked<ChargeAuthorizationService>;

    repo = {
      updateScoped: jest.fn().mockImplementation(async (id: string, patch: object) =>
        makePaymentIntent({ id, ...(patch as object) }),
      ),
    } as unknown as jest.Mocked<PaymentIntentRepository>;

    merchants = { getById: jest.fn().mockResolvedValue(makeMerchant()) } as unknown as jest.Mocked<MerchantsService>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConfirmPaymentFlow,
        PaymentIntentStateMachine,
        { provide: ChargeAuthorizationService, useValue: auth },
        { provide: PaymentIntentRepository, useValue: repo },
        { provide: MerchantsService, useValue: merchants },
        {
          provide: TransactionManager,
          useValue: {
            runInTransaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => unknown) => cb({})),
          },
        },
        { provide: PAYZENO_LOGGER, useValue: new NoopLogger() },
      ],
    }).compile();

    flow = moduleRef.get(ConfirmPaymentFlow);
  });

  it('moves the intent to processing before calling the acquirer', async () => {
    await flow.execute(makePaymentIntent(), {});

    const statuses = repo.updateScoped.mock.calls.map(
      ([, patch]) => (patch as { status?: string }).status,
    );
    expect(statuses[0]).toBe('processing');
  });

  it('ends in succeeded for an automatic-capture authorisation', async () => {
    const result = await flow.execute(makePaymentIntent({ capture_method: 'automatic' }), {});

    expect(result.status).toBe('succeeded');
  });

  it('ends in requires_capture for a manual-capture authorisation', async () => {
    auth.authorize.mockResolvedValue(makeCharge({ status: 'authorized' }) as never);

    const result = await flow.execute(makePaymentIntent({ capture_method: 'manual' }), {});

    expect(result.status).toBe('requires_capture');
  });

  it('ends in requires_action when the issuer demands an SCA challenge', async () => {
    auth.authorize.mockResolvedValue(
      makeCharge({
        status: 'pending',
        three_d_secure: {
          version: '2.2.0',
          authentication_flow: 'challenge',
          result: 'attempted',
          eci: '06',
          liability_shifted: false,
        },
      }) as never,
    );

    const result = await flow.execute(makePaymentIntent({ currency: 'EUR' }), {
      return_url: 'https://aurora.example/3ds',
    });

    expect(result.status).toBe('requires_action');
    expect(result.next_action).not.toBeNull();
  });

  it('records the latest charge id on the intent', async () => {
    const charge = makeCharge({ status: 'captured' });
    auth.authorize.mockResolvedValue(charge as never);

    await flow.execute(makePaymentIntent(), {});

    expect(repo.updateScoped).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ latest_charge_id: charge.id }),
    );
  });

  it('refuses to confirm an intent that is not confirmable', async () => {
    await expect(flow.execute(makePaymentIntent({ status: 'succeeded' }), {})).rejects.toThrow();
    expect(auth.authorize).not.toHaveBeenCalled();
  });

  it('marks the intent failed when the authorisation is declined', async () => {
    auth.authorize.mockRejectedValue(Object.assign(new Error('declined'), { code: 'card_declined' }));

    await expect(flow.execute(makePaymentIntent(), {})).rejects.toThrow();

    const statuses = repo.updateScoped.mock.calls.map(
      ([, patch]) => (patch as { status?: string }).status,
    );
    expect(statuses).toContain('failed');
  });

  it('uses the token on the request in preference to the one on the intent', async () => {
    await flow.execute(makePaymentIntent(), { payment_method_token: 'pmt_override' });

    expect(auth.authorize).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ payment_method_token: 'pmt_override' }),
    );
  });
});

/**
 * Built directly against the flow's current constructor, separately from the suite above so it
 * runs whatever state that suite is in.
 */
describe('ConfirmPaymentFlow — a decline', () => {
  it('points the intent at the declined charge, so its decline code can be shown', async () => {
    // Regression: landOnFailure moved the intent back to requires_payment_method without a
    // latest_charge_id, and the hosted checkout's `payment.last_error` was always null.
    const declined = Object.assign(new ChargeEntity(), { id: 'ch_declined', payment_intent_id: 'pi_1' });
    const intents = { transitionStatus: jest.fn().mockResolvedValue(1) };
    const charges = { listForIntent: jest.fn().mockResolvedValue([declined]) };
    const flow = new ConfirmPaymentFlow(
      intents as unknown as PaymentIntentRepository,
      new PaymentIntentStateMachine(),
      { runInTransaction: jest.fn(async (work: (manager: unknown) => unknown) => work({})) } as unknown as TransactionManager,
      { authorize: jest.fn().mockRejectedValue(new InsufficientFundsException()) } as unknown as ChargeAuthorizationService,
      {} as ChargeCaptureService,
      charges as unknown as ChargeRepository,
      {
        getById: jest.fn().mockResolvedValue(
          Object.assign(new MerchantEntity(), { id: 'mch_1', createdAt: new Date(), updatedAt: new Date() }),
        ),
      } as unknown as MerchantsService,
      // RFC platform-v2 §8. Unreached here: a decline never gets as far as the risk verdict.
      {} as RiskGate,
      { runtime: { nodeEnv: 'development' }, checkout: { publicUrl: 'http://pay.localhost' } } as ApiConfig,
      new NoopLogger(),
    );
    const intent = Object.assign(new PaymentIntentEntity(), {
      id: 'pi_1',
      merchantId: 'mch_1',
      status: 'requires_payment_method' as const,
      amount_minor: 2_400,
      currency: 'USD',
      capture_method: 'automatic' as const,
      latest_charge_id: null,
      livemode: true,
    });

    await expect(flow.execute(intent, { payment_method_token: 'pmt_1' })).rejects.toBeInstanceOf(
      InsufficientFundsException,
    );

    expect(intents.transitionStatus).toHaveBeenLastCalledWith(
      expect.anything(),
      'pi_1',
      'processing',
      'requires_payment_method',
      expect.objectContaining({ latest_charge_id: 'ch_declined' }),
    );
    expect(intent.latest_charge_id).toBe('ch_declined');
  });
});
