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

});
