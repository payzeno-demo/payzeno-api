import { UseGuards, type ExecutionContext } from '@nestjs/common';

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
    const { context, request } = guardContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.principal).toEqual(principal);
  });

  it('short-circuits when an earlier guard already authenticated the request', async () => {
    const guard = new StubGuard(principal);
    const { context } = guardContext({ principal: makeApiKeyPrincipal({ mode: 'test' }) });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // The point of the branch: a composite `apikey | session` route must not re-resolve.
    expect(guard.seen).toHaveLength(0);
  });

  it('raises AuthenticationRequiredException naming its own scheme when nothing resolves', async () => {
    const guard = new StubGuard(null);
    const { context } = guardContext();

    const err = await rejectsWith(guard.canActivate(context), AuthenticationRequiredException);

    expect(err.httpStatus).toBe(401);
    expect(err.code).toBe('authentication_required');
    expect(err.message).toContain('stub');
  });

  /**
   * Regression: on `@UseGuards(ApiKeyGuard, SessionGuard, …)` the api-key guard used to 401
   * every request without an `sk_` bearer, so a console session never reached SessionGuard and
   * a client secret never reached ClientSecretGuard. A missing credential is now fatal only for
   * the LAST credential guard in the handler's chain (controller guards, then method guards).
   */
  describe('composite chains', () => {
    class FirstScheme extends StubGuard {}
    class SecondScheme extends StubGuard {}
    class MethodScheme extends StubGuard {}

    @UseGuards(FirstScheme, SecondScheme)
    class CompositeController {
      list(): void {}

      @UseGuards(MethodScheme)
      confirm(): void {}
    }

    function contextFor(
      handler: () => void,
      request: AuthenticatedRequest = makeRequest(),
    ): ExecutionContext {
      const { context } = guardContext();
      return {
        ...context,
        switchToHttp: () => ({
          getRequest: <T>() => request as unknown as T,
          getResponse: <T>() => ({}) as T,
          getNext: <T>() => undefined as T,
        }),
        getHandler: () => handler,
        getClass: () => CompositeController,
      } as ExecutionContext;
    }

    it('passes through on a missing credential while a later scheme can still answer', async () => {
      const first = new FirstScheme(null);
      const request = makeRequest();

      await expect(first.canActivate(contextFor(CompositeController.prototype.list, request))).resolves.toBe(true);
      expect(request.principal).toBeUndefined();
    });

    it('lets the second scheme authenticate after the first found nothing', async () => {
      const request = makeRequest();
      const handler = CompositeController.prototype.list;

      await new FirstScheme(null).canActivate(contextFor(handler, request));
      await new SecondScheme(principal).canActivate(contextFor(handler, request));

      expect(request.principal).toEqual(principal);
    });

    it('rejects only when the last scheme in the chain found nothing either', async () => {
      const err = await rejectsWith(
        new SecondScheme(null).canActivate(contextFor(CompositeController.prototype.list)),
        AuthenticationRequiredException,
      );
      expect(err.httpStatus).toBe(401);
    });

    it('counts method-level guards, which run after the controller\'s', async () => {
      // On `confirm`, MethodScheme comes after SecondScheme, so SecondScheme is not last.
      await expect(
        new SecondScheme(null).canActivate(contextFor(CompositeController.prototype.confirm)),
      ).resolves.toBe(true);
      await rejectsWith(
        new MethodScheme(null).canActivate(contextFor(CompositeController.prototype.confirm)),
        AuthenticationRequiredException,
      );
    });
  });

  describe('bearerToken', () => {
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

    it('returns null for a bearer header with no value', () => {
      expect(guard.readBearer(makeRequest({ headers: { authorization: 'Bearer' } }))).toBeNull();
      expect(guard.readBearer(makeRequest({ headers: { authorization: 'Bearer   ' } }))).toBeNull();
    });

    it('returns null when there is no Authorization header at all', () => {
      expect(guard.readBearer(makeRequest())).toBeNull();
    });
  });

  it('reads cookies and headers without caring about header casing', () => {
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

    it('passes a single value and undefined through untouched', () => {
      expect(headerValue('only')).toBe('only');
      expect(headerValue(undefined)).toBeUndefined();
    });
  });
});
