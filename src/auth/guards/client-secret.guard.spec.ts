import type { ModuleRef } from '@nestjs/core';

import { ClientSecretGuard } from 'src/auth/guards/client-secret.guard';
import { PrincipalFactory } from 'src/auth/principal/principal.factory';
import {
  AuthenticationRequiredException,
  PermissionDeniedException,
} from 'src/common/errors/auth.exceptions';
import { PaymentIntentRepository } from 'src/payments/payment-intent.repository';

import { TEST_MERCHANT_ID, TEST_PAYMENT_INTENT_ID, fixedId } from 'test/factories/ids';
import { guardContext, rejectsWith } from 'test/support/guard-context';

/**
 * The browser-side checkout credential. Anything it can reach is effectively public, so the
 * principal it produces is pinned to exactly one PaymentIntent — not to the merchant.
 *
 * The route-pinning test is the reason for the class: without it, one customer's client
 * secret reads another customer's payment on the same merchant, and both requests look
 * perfectly legitimate to every other guard in the chain.
 */
describe('ClientSecretGuard', () => {
  const OTHER_INTENT_ID = fixedId('pi_', 'aurora-order-9902');
  const secret = `${TEST_PAYMENT_INTENT_ID}_secret_zg7q2m4v8k`;

  let intents: { findByClientSecret: jest.Mock };
  let guard: ClientSecretGuard;

  beforeEach(() => {
    intents = {
      findByClientSecret: jest.fn().mockResolvedValue({
        id: TEST_PAYMENT_INTENT_ID,
        merchantId: TEST_MERCHANT_ID,
      }),
    };

    guard = new ClientSecretGuard(
      { get: () => intents as unknown as PaymentIntentRepository } as unknown as ModuleRef,
      new PrincipalFactory(),
    );
    guard.onModuleInit();
  });

  it('resolves the secret and pins the principal to one payment intent', async () => {
    const { context, request } = guardContext({ headers: { authorization: `Bearer ${secret}` } });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(intents.findByClientSecret).toHaveBeenCalledWith(secret);
    expect(request.principal).toEqual({
      kind: 'client_secret',
      merchant_id: TEST_MERCHANT_ID,
      payment_intent_id: TEST_PAYMENT_INTENT_ID,
    });
  });

  it('admits the route whose :paymentIntentId matches the secret', async () => {
    const { context } = guardContext({
      headers: { authorization: `Bearer ${secret}` },
      params: { paymentIntentId: TEST_PAYMENT_INTENT_ID },
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('403s a route that names a different intent on the same merchant', async () => {
    const { context } = guardContext({
      headers: { authorization: `Bearer ${secret}` },
      params: { paymentIntentId: OTHER_INTENT_ID },
    });

    const err = await rejectsWith(guard.canActivate(context), PermissionDeniedException);

    expect(err.httpStatus).toBe(403);
    expect(err.toResponse('req_1').error.details).toMatchObject({
      reason: 'client_secret_scope',
    });
  });

  it('declines a pi_-prefixed token with no _secret_ marker — that is just an id', async () => {
    const { context } = guardContext({
      headers: { authorization: `Bearer ${TEST_PAYMENT_INTENT_ID}` },
    });

    await rejectsWith(guard.canActivate(context), AuthenticationRequiredException);
    expect(intents.findByClientSecret).not.toHaveBeenCalled();
  });

});
