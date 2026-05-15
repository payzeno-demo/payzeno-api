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
  let staffUsers: { resolveActive: jest.Mock };

  function guardWith(required?: StaffRole[]): StaffGuard {
    return new StaffGuard(
      sessions as unknown as SessionService,
      staffUsers as unknown as StaffUsersService,
      makeReflector(required ? { [STAFF_ONLY_KEY]: required } : {}),
    );
  }

  const cookies = { [SESSION_COOKIE]: 'sess_staff' };

  beforeEach(() => {
    sessions = {
      resolveStaff: jest.fn().mockResolvedValue(makeStaffPrincipalWithRole('risk', null)),
    };
    staffUsers = { resolveActive: jest.fn().mockResolvedValue(undefined) };
  });

  it('does nothing on a handler with no @StaffOnly — mixed controllers are legitimate', async () => {
    const { context, request } = guardContext({ cookies });

    await expect(guardWith().canActivate(context)).resolves.toBe(true);

    expect(sessions.resolveStaff).not.toHaveBeenCalled();
    expect(request.principal).toBeUndefined();
  });

  it('admits an operator whose role is exactly what the handler asked for', async () => {
    const { context, request } = guardContext({ cookies });

    await expect(guardWith(['risk']).canActivate(context)).resolves.toBe(true);

    expect(request.principal).toMatchObject({ kind: 'staff_session', role: 'risk' });
    expect(staffUsers.resolveActive).toHaveBeenCalled();
  });

  it('admits admin against any requirement', async () => {
    sessions.resolveStaff.mockResolvedValue(makeStaffPrincipalWithRole('admin', null));
    const { context } = guardContext({ cookies });

    await expect(guardWith(['finance']).canActivate(context)).resolves.toBe(true);
  });

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

  it("refuses a merchant's own admin session — this is the un-suspend-yourself hole", async () => {
    sessions.resolveStaff.mockResolvedValue(null);
    const { context } = guardContext({ cookies, principal: makeSessionPrincipal({ role: 'admin' }) });

    await rejectsWith(guardWith(['risk']).canActivate(context), PermissionDeniedException);
  });

  it('401s when no session cookie is presented', async () => {
    const { context } = guardContext();

    await rejectsWith(guardWith(['support']).canActivate(context), AuthenticationRequiredException);
    expect(sessions.resolveStaff).not.toHaveBeenCalled();
  });

  it('rechecks the staff row: a disabled operator keeps a live cookie until it expires', async () => {
    staffUsers.resolveActive.mockRejectedValue(
      new PermissionDeniedException('staff account is disabled or unknown'),
    );

    const { context } = guardContext({ cookies });

    await rejectsWith(guardWith(['risk']).canActivate(context), PermissionDeniedException);
  });

  describe('acting merchant resolution', () => {
    it('prefers ?merchant_id= — the required parameter on staff-marked scoped reads', async () => {
      const { context } = guardContext({ cookies, query: { merchant_id: TEST_MERCHANT_ID } });

      await guardWith(['support']).canActivate(context);

      expect(sessions.resolveStaff).toHaveBeenCalledWith(
        'sess_staff',
        'GET',
        undefined,
        TEST_MERCHANT_ID,
      );
    });

    it('falls back to the path parameter for /v1/merchants/:merchantId routes', async () => {
      const { context } = guardContext({ cookies, params: { merchantId: TEST_MERCHANT_ID } });

      await guardWith(['risk']).canActivate(context);

      expect(sessions.resolveStaff).toHaveBeenCalledWith(
        'sess_staff',
        'GET',
        undefined,
        TEST_MERCHANT_ID,
      );
    });

    it('passes null on the platform-wide routes — POST /v1/merchants has no merchant yet', async () => {
      const { context } = guardContext({ cookies, method: 'POST', url: '/v1/merchants' });

      await guardWith(['risk']).canActivate(context);

      expect(sessions.resolveStaff).toHaveBeenCalledWith('sess_staff', 'POST', undefined, null);
    });

    it('ignores an empty ?merchant_id= rather than scoping to the empty string', async () => {
      const { context } = guardContext({ cookies, query: { merchant_id: '' } });

      await guardWith(['support']).canActivate(context);

      expect(sessions.resolveStaff).toHaveBeenCalledWith('sess_staff', 'GET', undefined, null);
    });
  });
});
