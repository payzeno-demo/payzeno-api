import type { ModuleRef } from '@nestjs/core';

import { ProcessorSignatureGuard, SIGNATURE_HEADER } from 'src/auth/guards/processor-signature.guard';
import { AuthenticationRequiredException } from 'src/common/errors/auth.exceptions';
import { ProcessorSignatureVerifier } from 'src/payments/processor/processor-signature.verifier';

import { guardContext } from 'test/support/guard-context';

/**
 * `POST /v1/webhooks/:acquirer` — the only route in the API whose caller holds no Payzeno
 * credential. The acquirer signs the raw body with a shared secret and we verify the HMAC.
 *
 * The `rawBody` assertion is the one that matters. If a wiring change drops the raw-body
 * capture, verifying the re-serialised parsed object would still "work" for most payloads and
 * silently break for any whose key ordering differs — a downgrade to no verification at all
 * for the payloads that matter. So the guard refuses rather than falls back, and this spec
 * keeps it that way.
 */
describe('ProcessorSignatureGuard', () => {
  let verifier: { assertValid: jest.Mock };
  const rawBody = Buffer.from('{"event":"authorization.approved"}');

  it('attaches no principal — nothing downstream is scoped by the caller', () => {
    const { context, request } = guardContext({
      method: 'POST',
      params: { acquirer: 'nordpay' },
      headers: { [SIGNATURE_HEADER]: 't=1,v1=a' },
      rawBody,
    });

    guard.canActivate(context);

    expect(request.principal).toBeUndefined();
  });
});
