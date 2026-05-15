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

  beforeEach(() => {
    verifier = { assertValid: jest.fn() };
    guard = new ProcessorSignatureGuard({
      get: () => verifier as unknown as ProcessorSignatureVerifier,
    } as unknown as ModuleRef);
    guard.onModuleInit();
  });

  it('accepts the second acquirer too', () => {
    const { context } = guardContext({
      method: 'POST',
      params: { acquirer: 'nordpay' },
      headers: { [SIGNATURE_HEADER]: 't=1767225600,v1=cafe' },
      rawBody,
    });

    expect(guard.canActivate(context)).toBe(true);
    expect(verifier.assertValid).toHaveBeenCalledWith('nordpay', rawBody, 't=1767225600,v1=cafe');
  });

  it('rejects an unknown acquirer before looking at the signature', () => {
    const { context } = guardContext({
      method: 'POST',
      params: { acquirer: 'not-an-acquirer' },
      headers: { [SIGNATURE_HEADER]: 't=1,v1=x' },
      rawBody,
    });

    expect(() => guard.canActivate(context)).toThrow(AuthenticationRequiredException);
    expect(verifier.assertValid).not.toHaveBeenCalled();
  });

  it('rejects a request with no :acquirer path parameter', () => {
    const { context } = guardContext({ method: 'POST', headers: { [SIGNATURE_HEADER]: 'x' }, rawBody });

    expect(() => guard.canActivate(context)).toThrow(AuthenticationRequiredException);
  });

  it('rejects a missing signature header', () => {
    const { context } = guardContext({ method: 'POST', params: { acquirer: 'worldflow' }, rawBody });

    expect(() => guard.canActivate(context)).toThrow(AuthenticationRequiredException);
    expect(verifier.assertValid).not.toHaveBeenCalled();
  });

  it('refuses rather than verifying a re-serialised body when rawBody is absent', () => {
    const { context } = guardContext({
      method: 'POST',
      params: { acquirer: 'worldflow' },
      headers: { [SIGNATURE_HEADER]: 't=1767225600,v1=deadbeef' },
      body: { event: 'authorization.approved' },
    });

    expect(() => guard.canActivate(context)).toThrow(/Raw body unavailable/);
    expect(verifier.assertValid).not.toHaveBeenCalled();
  });

  it('lets the verifier own the rejection when the HMAC does not match', () => {
    verifier.assertValid.mockImplementation(() => {
      throw new AuthenticationRequiredException('acquirer signature mismatch');
    });

    const { context } = guardContext({
      method: 'POST',
      params: { acquirer: 'worldflow' },
      headers: { [SIGNATURE_HEADER]: 't=1767225600,v1=0000' },
      rawBody,
    });

    expect(() => guard.canActivate(context)).toThrow(AuthenticationRequiredException);
  });

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
