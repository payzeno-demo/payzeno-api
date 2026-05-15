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

  it('is a no-op on an empty @Roles list', () => {
    const { context } = guardContext({ principal: makeSessionPrincipalWithRole('viewer') });

    expect(guardWith([]).canActivate(context)).toBe(true);
  });

  describe.each<[UserRole, UserRole[], boolean]>([
    ['owner', ['owner'], true],
    ['owner', ['admin'], true],
    ['admin', ['owner', 'admin'], true],
    ['admin', ['owner'], false],
    ['developer', ['developer'], true],
    ['developer', ['admin'], false],
    ['viewer', ['developer'], false],
    ['viewer', ['owner', 'admin'], false],
  ])('a %s session against @Roles(%s)', (role, required, allowed) => {
    it(allowed ? 'passes' : 'is denied with 403', () => {
      const { context } = guardContext({ principal: makeSessionPrincipalWithRole(role) });
      const guard = guardWith(required);

      if (allowed) {
        expect(guard.canActivate(context)).toBe(true);
        return;
      }

      expect(() => guard.canActivate(context)).toThrow(PermissionDeniedException);
    });
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

  it('lets an API key through — a key is not a person and ApiKeyGuard checked its scopes', () => {
    const { context } = guardContext({ principal: makeApiKeyPrincipal() });

    expect(guardWith(['owner']).canActivate(context)).toBe(true);
  });

  it('refuses a client-secret principal outright', () => {
    const { context } = guardContext({ principal: makeClientSecretPrincipal() });

    expect(() => guardWith(['developer']).canActivate(context)).toThrow(PermissionDeniedException);
  });

  it('refuses an internal-service principal on a /v1 role-gated route', () => {
    const { context } = guardContext({ principal: makeInternalPrincipal() });

    expect(() => guardWith(['developer']).canActivate(context)).toThrow(PermissionDeniedException);
  });

  it('401s when no auth guard ran before it', () => {
    const { context } = guardContext();

    expect(() => guardWith(['owner']).canActivate(context)).toThrow(AuthenticationRequiredException);
  });
});
