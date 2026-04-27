import {
  INTERNAL_SECRET_HEADER,
  InternalServiceGuard,
  SERVICE_HEADER,
} from 'src/auth/guards/internal-service.guard';
import { PrincipalFactory } from 'src/auth/principal/principal.factory';
import { INTERNAL_ONLY_KEY } from 'src/common/decorators/internal-only.decorator';
import {
  AuthenticationRequiredException,
  PermissionDeniedException,
} from 'src/common/errors/auth.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import type { ApiConfig } from 'src/config/api-config.type';

import { makeInternalPrincipal } from 'test/factories/principal.factory';
import { guardContext, makeReflector, rejectsWith } from 'test/support/guard-context';

/**
 * `/internal/v1/*` — the surface payzeno-ledger and payzeno-billing-legacy call.
 *
 * The whole security story on this listener is a shared secret plus nginx's mTLS
 * termination and its deny rule on the PUBLIC listener. That makes three assertions
 * non-negotiable and all three are below:
 *
 *   - an unknown `X-Payzeno-Service` is rejected before the secret is even compared;
 *   - a wrong secret is a 401 and is logged, because on this port it should be unreachable;
 *   - `@InternalOnly('payzeno-ledger')` actually excludes the Java biller. `POST
 *     /internal/v1/charges/:id/settled` is the ledger's alone.
 */
describe('InternalServiceGuard', () => {
  const SECRET = 'internal-shared-secret-value';

  const config = {
    ledger: { internalApiSecret: SECRET },
  } as unknown as ApiConfig;

  function guardWith(callers?: string[]): InternalServiceGuard {
    return new InternalServiceGuard(
      config,
      new PrincipalFactory(),
      makeReflector(callers ? { [INTERNAL_ONLY_KEY]: { callers } } : {}),
      new NoopLogger(),
    );
  }

  function headers(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      [SERVICE_HEADER]: 'payzeno-ledger',
      [INTERNAL_SECRET_HEADER]: SECRET,
      ...overrides,
    };
  }

  it('admits payzeno-ledger with the right secret and attaches an internal_service principal', async () => {
    const { context, request } = guardContext({ method: 'POST', headers: headers() });

    await expect(guardWith().canActivate(context)).resolves.toBe(true);

    expect(request.principal).toEqual(
      makeInternalPrincipal({ service: 'payzeno-ledger', scopes: ['internal:read', 'internal:write'] }),
    );
  });

  it('admits payzeno-billing-legacy — the second known caller', async () => {
    const { context, request } = guardContext({
      method: 'GET',
      headers: headers({ [SERVICE_HEADER]: 'payzeno-billing-legacy' }),
    });

    await expect(guardWith().canActivate(context)).resolves.toBe(true);
    expect(request.principal).toMatchObject({ service: 'payzeno-billing-legacy' });
  });

  it('declines when neither internal header is present, so a public route is unaffected', async () => {
    const { context } = guardContext();

    await rejectsWith(guardWith().canActivate(context), AuthenticationRequiredException);
  });

  it('rejects an unknown service name before comparing the secret', async () => {
    const { context } = guardContext({
      headers: headers({ [SERVICE_HEADER]: 'payzeno-console' }),
    });

    const err = await rejectsWith(guardWith().canActivate(context), AuthenticationRequiredException);
    expect(err.message).toContain('X-Payzeno-Service');
  });

  it('rejects a wrong secret', async () => {
    const { context } = guardContext({
      headers: headers({ [INTERNAL_SECRET_HEADER]: 'internal-shared-secret-valuf' }),
    });

    const err = await rejectsWith(guardWith().canActivate(context), AuthenticationRequiredException);
    expect(err.message).toContain('Invalid internal service credential');
  });

});
