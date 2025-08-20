import type { StaffRole } from '@payzeno/contracts';

import { StaffGuard } from 'src/auth/guards/staff.guard';
import { SESSION_COOKIE, SessionService } from 'src/auth/session/session.service';
import { STAFF_ONLY_KEY } from 'src/common/decorators/staff-only.decorator';
import {
  AuthenticationRequiredException,
  PermissionDeniedException,
} from 'src/common/errors/auth.exceptions';
import { StaffUsersService } from 'src/staff/staff-users.service';

import {
  makeFinanceStaffPrincipal,
  makeSessionPrincipal,
  makeStaffPrincipalWithRole,
} from 'test/factories/principal.factory';
import { TEST_MERCHANT_ID } from 'test/factories/ids';
import { guardContext, makeReflector, rejectsWith } from 'test/support/guard-context';

/**
 * `staff` is not `admin`, and this spec exists to keep it that way. A merchant's own `admin`
 * reaching a staff route means a suspended merchant can un-suspend itself — the single worst
 * authorisation bug this API could have.
 *
 * The four roles are peers, not a ladder: `admin` satisfies everything, and `finance`,
 * `risk` and `support` satisfy only themselves. A finance operator has no business accepting
 * a dispute on a merchant's behalf.
 */
describe('StaffGuard', () => {
  let sessions: { resolveStaff: jest.Mock };
  function guardWith(required?: StaffRole[]): StaffGuard {
    return new StaffGuard(
      sessions as unknown as SessionService,
      staffUsers as unknown as StaffUsersService,
      makeReflector(required ? { [STAFF_ONLY_KEY]: required } : {}),
    );
  }

  it('refuses finance on a risk-only route — the roles are peers, not a ladder', async () => {
    sessions.resolveStaff.mockResolvedValue(makeFinanceStaffPrincipal(null));
    const { context } = guardContext({ cookies });

    const err = await rejectsWith(
      guardWith(['risk']).canActivate(context),
      PermissionDeniedException,
    );

    expect(err.httpStatus).toBe(403);
    expect(err.toResponse('req_1').error.details).toMatchObject({ required_roles: 'risk' });
  });

});
