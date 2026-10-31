import type { ModuleRef } from '@nestjs/core';

import { ClientSecretGuard } from 'src/auth/guards/client-secret.guard';
import { PrincipalFactory } from 'src/auth/principal/principal.factory';
import { ACCEPTS_CLIENT_SECRET_KEY } from 'src/common/decorators/accepts-client-secret.decorator';
import {
  AuthenticationRequiredException,
  PermissionDeniedException,
} from 'src/common/errors/auth.exceptions';
import { PaymentIntentRepository } from 'src/payments/payment-intent.repository';

import { TEST_MERCHANT_ID, TEST_PAYMENT_INTENT_ID, fixedId } from 'test/factories/ids';
import { guardContext, makeReflector, rejectsWith } from 'test/support/guard-context';

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
        livemode: false,
      }),
    };

    guard = new ClientSecretGuard(
      { get: () => intents as unknown as PaymentIntentRepository } as unknown as ModuleRef,
      new PrincipalFactory(),
      makeReflector({ [ACCEPTS_CLIENT_SECRET_KEY]: true }),
    );
    guard.onModuleInit();
  });

  it('resolves the secret and pins the principal to one payment intent', async () => {
    const { context, request } = guardContext({ headers: { authorization: `Bearer ${secret}` } });

    await expect(guard.canActivate(context)).resolves.toBe(true);

    expect(intents.findByClientSecret).toHaveBeenCalledWith(secret);
    // `livemode` is the intent's — this one is a test-mode intent.
    expect(request.principal).toEqual({
      kind: 'client_secret',
      merchant_id: TEST_MERCHANT_ID,
      payment_intent_id: TEST_PAYMENT_INTENT_ID,
      livemode: false,
    });
  });

  // Regression: the guard now sits in the controller's chain (ahead of MerchantScopeGuard), so
  // it must not turn a client secret into a principal on handlers that never accepted one —
  // a list route would otherwise hand the whole merchant to a browser.
  it('ignores a client secret on a handler not marked @AcceptsClientSecret()', async () => {
    const unmarked = new ClientSecretGuard(
      { get: () => intents as unknown as PaymentIntentRepository } as unknown as ModuleRef,
      new PrincipalFactory(),
      makeReflector(),
    );
    unmarked.onModuleInit();
    const { context, request } = guardContext({ headers: { authorization: `Bearer ${secret}` } });

    await rejectsWith(unmarked.canActivate(context), AuthenticationRequiredException);
    expect(intents.findByClientSecret).not.toHaveBeenCalled();
    expect(request.principal).toBeUndefined();
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

  it('declines a bearer token that is not a client secret, so ApiKeyGuard can win', async () => {
    const { context } = guardContext({
      headers: { authorization: 'Bearer sk_live_ab12cd34_secretsecretsecret' },
    });

    await rejectsWith(guard.canActivate(context), AuthenticationRequiredException);
    expect(intents.findByClientSecret).not.toHaveBeenCalled();
  });

  it('declines a pi_-prefixed token with no _secret_ marker — that is just an id', async () => {
    const { context } = guardContext({
      headers: { authorization: `Bearer ${TEST_PAYMENT_INTENT_ID}` },
    });

    await rejectsWith(guard.canActivate(context), AuthenticationRequiredException);
    expect(intents.findByClientSecret).not.toHaveBeenCalled();
  });

  it('gives a well-shaped secret that resolves to nothing the same answer as a missing one', async () => {
    intents.findByClientSecret.mockResolvedValue(null);

    const { context } = guardContext({ headers: { authorization: `Bearer ${secret}` } });
    const resolvedToNothing = await rejectsWith(
      guard.canActivate(context),
      AuthenticationRequiredException,
    );

    const noCredential = await rejectsWith(
      guard.canActivate(guardContext().context),
      AuthenticationRequiredException,
    );

    // Different messages would let a caller probe which intents exist.
    expect(resolvedToNothing.httpStatus).toBe(noCredential.httpStatus);
    expect(resolvedToNothing.code).toBe(noCredential.code);
  });
});
