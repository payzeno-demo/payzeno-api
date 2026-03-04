import type { ApiKeyScope } from '@payzeno/contracts';

import { ApiKeyResolver } from 'src/auth/api-key/api-key.resolver';
import { ApiKeyGuard } from 'src/auth/guards/api-key.guard';
import { REQUIRED_SCOPES_KEY } from 'src/common/decorators/required-scopes.decorator';
import {
  AuthenticationRequiredException,
  PermissionDeniedException,
} from 'src/common/errors/auth.exceptions';

import {
  makeApiKeyPrincipal,
  makeScopedApiKeyPrincipal,
  makeSessionPrincipal,
} from 'test/factories/principal.factory';
import { guardContext, makeReflector, rejectsWith } from 'test/support/guard-context';

/**
 * `Authorization: Bearer sk_live_…`.
 *
 * Two responsibilities and they are separable: resolving the credential (ApiKeyResolver's
 * job, verified in its own spec) and enforcing `@RequiredScopes(...)`, which only a guard can
 * do because the requirement is handler metadata.
 *
 * The `sk_` prefix check matters more than it looks. Composite routes list this guard first;
 * a session-cookie request has no bearer token at all and a client-secret request has one
 * that starts `pi_`. Returning null instead of throwing is what lets the next guard try.
 */
describe('ApiKeyGuard', () => {
  let resolver: { resolve: jest.Mock };

  function guardWith(requiredScopes?: ApiKeyScope[]): ApiKeyGuard {
    return new ApiKeyGuard(
      resolver as unknown as ApiKeyResolver,
      makeReflector(requiredScopes ? { [REQUIRED_SCOPES_KEY]: requiredScopes } : {}),
    );
  }

  beforeEach(() => {
    resolver = { resolve: jest.fn() };
  });

  it('resolves a live key and attaches the api_key principal', async () => {
    const principal = makeApiKeyPrincipal();
    resolver.resolve.mockResolvedValue(principal);

    const { context, request } = guardContext({
      headers: { authorization: 'Bearer sk_live_ab12cd34_verysecretvaluehere' },
    });

    await expect(guardWith().canActivate(context)).resolves.toBe(true);

    expect(resolver.resolve).toHaveBeenCalledWith('sk_live_ab12cd34_verysecretvaluehere');
    expect(request.principal).toEqual(principal);
  });

  it('declines to handle a credential that is not an API key, so the next guard can try', async () => {
    const { context } = guardContext({ headers: { authorization: 'Bearer pi_abc_secret_xyz' } });

    // Null from `authenticate` becomes the base's 401 when this is the only guard, but the
    // resolver must not have been asked — that is the observable "not mine" behaviour.
    await rejectsWith(guardWith().canActivate(context), AuthenticationRequiredException);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('401s when no Authorization header is present at all', async () => {
    const { context } = guardContext();

    await rejectsWith(guardWith().canActivate(context), AuthenticationRequiredException);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('lets the resolver own the invalid-key exception rather than remapping it', async () => {
    class Boom extends Error {}
    resolver.resolve.mockRejectedValue(new Boom('invalid'));

    const { context } = guardContext({
      headers: { authorization: 'Bearer sk_test_ab12cd34_verysecretvaluehere' },
    });

    await expect(guardWith().canActivate(context)).rejects.toBeInstanceOf(Boom);
  });

  describe('@RequiredScopes', () => {
    beforeEach(() => {
      resolver.resolve.mockImplementation(async () =>
        makeScopedApiKeyPrincipal(['refunds:write', 'charges:read']),
      );
    });

    const request = { headers: { authorization: 'Bearer sk_live_ab12cd34_verysecretvaluehere' } };

    it('passes when the granted set covers the requirement', async () => {
      const { context } = guardContext(request);

      await expect(guardWith(['charges:read']).canActivate(context)).resolves.toBe(true);
    });

    it('passes on an implied scope — refunds:write grants refunds:read', async () => {
      const { context } = guardContext(request);

      await expect(guardWith(['refunds:read']).canActivate(context)).resolves.toBe(true);
    });

    it('403s naming the first missing scope', async () => {
      const { context } = guardContext(request);

      const err = await rejectsWith(
        guardWith(['payouts:write']).canActivate(context),
        PermissionDeniedException,
      );

      expect(err.httpStatus).toBe(403);
      expect(err.message).toContain('payouts:write');
    });

    it('is a no-op when the handler declares no scopes', async () => {
      const { context } = guardContext(request);

      await expect(guardWith().canActivate(context).then(() => true)).resolves.toBe(true);
    });

    it('does not run the scope check for a principal that is not an API key', async () => {
      // A composite route where SessionGuard won first: the principal on the request is a
      // dashboard session, and asserting API-key scopes against it would deny every console
      // user on a scope-marked handler.
      const { context } = guardContext({ ...request, principal: makeSessionPrincipal() });

      await expect(guardWith(['payouts:write']).canActivate(context)).resolves.toBe(true);
      expect(resolver.resolve).not.toHaveBeenCalled();
    });
  });
});
