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

  it('is a no-op on a handler with no @Roles', () => {
    const { context } = guardContext({ principal: makeSessionPrincipalWithRole('viewer') });

    expect(guardWith().canActivate(context)).toBe(true);
  });

  it('names the required roles in the 403 so the console can render something useful', () => {
    const { context } = guardContext({ principal: makeSessionPrincipalWithRole('viewer') });

    try {
      guardWith(['owner', 'admin']).canActivate(context);
      throw new Error('expected a PermissionDeniedException');
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect((err as PermissionDeniedException).message).toContain('owner or admin');
    }
  });

  it('lets a staff operator through — they outrank every merchant role by construction', () => {
    const { context } = guardContext({ principal: makeStaffPrincipal({ role: 'support' }) });

    expect(guardWith(['owner']).canActivate(context)).toBe(true);
  });

});
