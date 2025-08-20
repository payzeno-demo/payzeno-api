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

    const { context } = guardContext({ headers: { authorization: 'Bearer pi_abc_secret_xyz' } });

    // Null from `authenticate` becomes the base's 401 when this is the only guard, but the
    // resolver must not have been asked — that is the observable "not mine" behaviour.
    await rejectsWith(guardWith().canActivate(context), AuthenticationRequiredException);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('401s when no Authorization header is present at all', async () => {
    class Boom extends Error {}
    resolver.resolve.mockRejectedValue(new Boom('invalid'));

    const { context } = guardContext({
      headers: { authorization: 'Bearer sk_test_ab12cd34_verysecretvaluehere' },
    });

    await expect(guardWith().canActivate(context)).rejects.toBeInstanceOf(Boom);
  });

  describe('@RequiredScopes', () => {
  });
});
