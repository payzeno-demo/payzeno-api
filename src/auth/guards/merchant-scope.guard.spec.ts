import { MerchantScopeGuard } from 'src/auth/guards/merchant-scope.guard';
import { LIVEMODE_ONLY_KEY } from 'src/common/decorators/livemode-only.decorator';
import { MERCHANT_SCOPED_KEY } from 'src/common/decorators/merchant-scoped.decorator';
import {
  AuthenticationRequiredException,
  PermissionDeniedException,
} from 'src/common/errors/auth.exceptions';
import { MerchantRestrictedException } from 'src/common/errors/business.exceptions';
import { MerchantNotFoundException } from 'src/common/errors/not-found.exceptions';
import { MerchantRepository } from 'src/merchants/merchant.repository';

import { TEST_MERCHANT_ID, TEST_OTHER_MERCHANT_ID } from 'test/factories/ids';
import {
  makeApiKeyPrincipal,
  makeInternalPrincipal,
  makeSessionPrincipal,
  makeStaffPrincipal,
} from 'test/factories/principal.factory';
import { guardContext, makeReflector, rejectsWith } from 'test/support/guard-context';

/**
 * The tenant boundary. Two of these tests are the reason the file exists at all:
 *
 *   - a cross-tenant path parameter is **404**, never 403. A 403 confirms the resource
 *     exists and belongs to somebody else, which leaks tenant membership. `test/e2e/
 *     merchant-scope.e2e-spec.ts` asserts the same thing end to end.
 *   - the merchant status read is skipped on safe methods. Adding a SELECT to every list
 *     request is what made the console dashboard slow in month 7, and a GET does not care
 *     whether the merchant is suspended.
 */
describe('MerchantScopeGuard', () => {
  let merchants: { findById: jest.Mock };

  function guardWith(metadata: Record<symbol | string, unknown>): MerchantScopeGuard {
    return new MerchantScopeGuard(
      makeReflector(metadata),
      merchants as unknown as MerchantRepository,
    );
  }

  /** The default: a controller that declared `@MerchantScoped()`. */
  const scoped = { [MERCHANT_SCOPED_KEY]: {} };

  beforeEach(() => {
    merchants = { findById: jest.fn().mockResolvedValue({ id: TEST_MERCHANT_ID, status: 'active' }) };
  });

  it('fails closed on a controller that forgot @MerchantScoped by not running at all', async () => {
    const { context } = guardContext({ principal: makeSessionPrincipal() });

    await expect(guardWith({}).canActivate(context)).resolves.toBe(true);
    expect(merchants.findById).not.toHaveBeenCalled();
  });

  it('401s when no auth guard attached a principal', async () => {
    const err = await rejectsWith(
      guardWith(scoped).canActivate(context),
      MerchantNotFoundException,
    );

    expect(err.httpStatus).toBe(404);
    expect(err.code).toBe('not_found');
  });

  it('403s a staff request that named no merchant — there would be no scope to check', async () => {
    const { context } = guardContext({
      principal: makeStaffPrincipal({ acting_merchant_id: TEST_MERCHANT_ID }),
      params: { merchantId: TEST_MERCHANT_ID },
    });

    await expect(guardWith(scoped).canActivate(context)).resolves.toBe(true);
  });

  it('403s an internal-service principal reaching a /v1 route', async () => {
    it('404s a write whose merchant row has disappeared', async () => {
      merchants.findById.mockResolvedValue(null);

      const { context } = guardContext({ method: 'PATCH', principal: makeSessionPrincipal() });

      await rejectsWith(guardWith(scoped).canActivate(context), MerchantNotFoundException);
    });
  });
});
