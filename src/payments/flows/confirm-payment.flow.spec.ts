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
  it('uses the token on the request in preference to the one on the intent', async () => {
    await flow.execute(makePaymentIntent(), { payment_method_token: 'pmt_override' });

    expect(auth.authorize).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ payment_method_token: 'pmt_override' }),
    );
  });
});
