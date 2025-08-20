import type { UserRole } from '@payzeno/contracts';

import { RolesGuard } from 'src/auth/guards/roles.guard';
import { ROLES_KEY } from 'src/common/decorators/roles.decorator';
import {
  AuthenticationRequiredException,
  PermissionDeniedException,
} from 'src/common/errors/auth.exceptions';

import {
  makeApiKeyPrincipal,
  makeClientSecretPrincipal,
  makeInternalPrincipal,
  makeSessionPrincipalWithRole,
  makeStaffPrincipal,
} from 'test/factories/principal.factory';
import { guardContext, makeReflector } from 'test/support/guard-context';

/**
 * `owner ⊃ admin ⊃ developer ⊃ viewer`, and only for the merchant's own dashboard users.
 *
 * The table below is the whole contract. The rows that surprise people are the last three:
 * an API key has no role (its scopes were already checked by ApiKeyGuard), a staff operator
 * outranks every merchant role by construction, and a browser client secret can never reach
 * anything role-gated at all.
 */
describe('RolesGuard', () => {
  function guardWith(required?: UserRole[]): RolesGuard {
    return new RolesGuard(makeReflector(required ? { [ROLES_KEY]: required } : {}));
  }

  it('lets a staff operator through — they outrank every merchant role by construction', () => {
    const { context } = guardContext({ principal: makeStaffPrincipal({ role: 'support' }) });

    expect(guardWith(['owner']).canActivate(context)).toBe(true);
  });

});
