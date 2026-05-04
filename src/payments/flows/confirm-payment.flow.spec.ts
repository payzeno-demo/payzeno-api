import { Test } from '@nestjs/testing';

import { NoopLogger, PayzenoLogger } from 'src/common/logging/logger';
import { TransactionManager } from 'src/common/persistence/transaction.manager';
import { ChargeAuthorizationService } from 'src/payments/charge-authorization.service';
import { ConfirmPaymentFlow } from 'src/payments/flows/confirm-payment.flow';
import { MerchantsService } from 'src/merchants/merchants.service';
import { PaymentIntentRepository } from 'src/payments/payment-intent.repository';
import { PaymentIntentStateMachine } from 'src/payments/state/payment-intent.state-machine';

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
        { provide: PayzenoLogger, useValue: new NoopLogger() },
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
