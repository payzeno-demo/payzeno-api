import type { AuthPrincipal } from '@payzeno/contracts';

import {
  BaseAuthGuard,
  headerValue,
  type AuthenticatedRequest,
} from 'src/auth/guards/base-auth.guard';
import { AuthenticationRequiredException } from 'src/common/errors/auth.exceptions';

import { makeApiKeyPrincipal } from 'test/factories/principal.factory';
import { guardContext, makeRequest, rejectsWith } from 'test/support/guard-context';

/**
 * The abstract root of all five credential guards. Everything asserted here is inherited by
 * ApiKeyGuard, SessionGuard, ClientSecretGuard, StaffGuard and InternalServiceGuard, so a
 * regression here is a regression in every one of them at once.
 *
 * The composite-route behaviour in the first block is the one that is easy to break: routes
 * marked `apikey | session` list two guards, and whichever resolves first must win without
 * the second one wiping the principal.
 */
class StubGuard extends BaseAuthGuard {
  protected readonly scheme = 'stub';

  constructor(private readonly result: AuthPrincipal | null) {
    super();
  }

  readonly seen: AuthenticatedRequest[] = [];

  protected async authenticate(request: AuthenticatedRequest): Promise<AuthPrincipal | null> {
    this.seen.push(request);
    return this.result;
  }

  /** Exposed so the token/cookie/header helpers can be exercised without a subclass each. */
  readBearer(request: AuthenticatedRequest): string | null {
    return this.bearerToken(request);
  }

  readCookie(request: AuthenticatedRequest, name: string): string | undefined {
    return this.cookie(request, name);
  }

  readHeader(request: AuthenticatedRequest, name: string): string | undefined {
    return this.header(request, name);
  }
}

describe('BaseAuthGuard', () => {
  const principal = makeApiKeyPrincipal();

  it('attaches the resolved principal to the request', async () => {
    const guard = new StubGuard(principal);
    const { context } = guardContext({ principal: makeApiKeyPrincipal({ mode: 'test' }) });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // The point of the branch: a composite `apikey | session` route must not re-resolve.
    expect(guard.seen).toHaveLength(0);
  });

  it('raises AuthenticationRequiredException naming its own scheme when nothing resolves', async () => {
    const guard = new StubGuard(null);
    it('accepts any casing of the scheme, per RFC 7235', () => {
      expect(guard.readBearer(makeRequest({ headers: { authorization: 'Bearer sk_live_x' } }))).toBe(
        'sk_live_x',
      );
      expect(guard.readBearer(makeRequest({ headers: { authorization: 'bearer sk_live_x' } }))).toBe(
        'sk_live_x',
      );
      expect(guard.readBearer(makeRequest({ headers: { authorization: 'BEARER sk_live_x' } }))).toBe(
        'sk_live_x',
      );
    });

    it('rejects a non-bearer scheme rather than treating the whole header as a token', () => {
      expect(guard.readBearer(makeRequest({ headers: { authorization: 'Basic abc' } }))).toBeNull();
    });

    const guard = new StubGuard(null);
    const request = makeRequest({
      cookies: { pz_session: 'sess_1' },
      headers: { 'X-Payzeno-Service': 'payzeno-ledger' },
    });

    expect(guard.readCookie(request, 'pz_session')).toBe('sess_1');
    expect(guard.readCookie(request, 'pz_csrf')).toBeUndefined();
    expect(guard.readHeader(request, 'X-Payzeno-Service')).toBe('payzeno-ledger');
    expect(guard.readHeader(request, 'x-payzeno-service')).toBe('payzeno-ledger');
  });

  describe('headerValue', () => {
    it('collapses a repeated header to its first value', () => {
      expect(headerValue(['first', 'second'])).toBe('first');
    });

  });
});
