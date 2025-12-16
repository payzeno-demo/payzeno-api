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
  let repo: jest.Mocked<PaymentIntentRepository>;
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

  it('ends in requires_capture for a manual-capture authorisation', async () => {
    auth.authorize.mockResolvedValue(makeCharge({ status: 'authorized' }) as never);

    const result = await flow.execute(makePaymentIntent({ capture_method: 'manual' }), {});

    expect(result.status).toBe('requires_capture');
  });

  it('refuses to confirm an intent that is not confirmable', async () => {
    await expect(flow.execute(makePaymentIntent({ status: 'succeeded' }), {})).rejects.toThrow();
    expect(auth.authorize).not.toHaveBeenCalled();
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
