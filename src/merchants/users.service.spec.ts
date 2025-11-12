import { ValidationException } from 'src/common/errors/api.exception';
import { PermissionDeniedException } from 'src/common/errors/auth.exceptions';
import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import type { MerchantUserRepository } from 'src/merchants/users/merchant-user.repository';
import { MerchantUsersService } from 'src/merchants/users/users.service';

import { TEST_MERCHANT_ID, TEST_USER_ID, fixedId } from 'test/factories/ids';
import { FixedClock } from 'test/support/fixed-clock';

/**
 * ytechdebt's directory, and it sits just above the 80% gate on purpose. What IS covered is
 * the rule with teeth: `assertNotLastOwner`. Removing or demoting the last `owner` leaves a
 * merchant nobody can administer and the only fix is a staff operator with database access.
 * It has happened twice.
 *
 * The invite path deliberately does NOT assert the email is sent, because it is not sent —
 * see the TODO(PAY-1907) in the service. A test asserting behaviour the code does not have
 * is worse than no test.
 */
describe('MerchantUsersService', () => {
  const clock = new FixedClock('2026-05-02T11:30:00.000Z');
  const OTHER_USER_ID = fixedId('usr_', 'aurora-developer');

  let users: {
    listForMerchant: jest.Mock;
    findByIdForMerchant: jest.Mock;
    findByEmailForMerchant: jest.Mock;
    insertMapped: jest.Mock;
    updateRole: jest.Mock;
    disable: jest.Mock;
    countOwners: jest.Mock;
  };
  let service: MerchantUsersService;

  function userRow(overrides: Record<string, unknown> = {}) {
    const row = {
      id: TEST_USER_ID,
      merchantId: TEST_MERCHANT_ID,
      email: 'ops@auroracoffee.example',
      fullName: 'Aurora Ops',
      role: 'owner',
      status: 'active',
      toUser: () => ({
        id: row.id as string,
        object: 'user' as const,
        merchant_id: TEST_MERCHANT_ID,
        email: row.email as string,
        full_name: row.fullName as string,
        role: row.role as 'owner',
        last_login_at: null,
        created_at: '2026-01-02T08:00:00.000Z',
      }),
      ...overrides,
    };
    return row;
  }

  beforeEach(() => {
    users = {
      listForMerchant: jest.fn().mockResolvedValue([userRow()]),
      findByIdForMerchant: jest.fn().mockResolvedValue(userRow()),
      findByEmailForMerchant: jest.fn().mockResolvedValue(null),
      insertMapped: jest.fn().mockResolvedValue(undefined),
      updateRole: jest.fn().mockResolvedValue(undefined),
      disable: jest.fn().mockResolvedValue(undefined),
      countOwners: jest.fn().mockResolvedValue(2),
    };

    service = new MerchantUsersService(
      users as unknown as MerchantUserRepository,
      new IdFactory(),
      clock,
      new NoopLogger(),
    );
  });

  describe('list', () => {
    it('creates the row as invited with an unusable password hash', async () => {
      await service.invite(TEST_MERCHANT_ID, input);

      const [row] = users.insertMapped.mock.calls[0];
      expect(row.status).toBe('invited');
      expect(row.passwordHash).toMatch(/^\$argon2/);
      expect(row.lastLoginAt).toBeNull();
    });

    it('disables rather than deleting — audit_log.actor_id points at these rows', async () => {
      users.findByIdForMerchant.mockResolvedValue(userRow({ id: OTHER_USER_ID, role: 'developer' }));

      await service.remove(TEST_MERCHANT_ID, OTHER_USER_ID, TEST_USER_ID);

      expect(users.disable).toHaveBeenCalledWith(TEST_MERCHANT_ID, OTHER_USER_ID);
    });

    it('refuses to remove the last owner', async () => {
      users.countOwners.mockResolvedValue(1);

      await expect(
        service.remove(TEST_MERCHANT_ID, TEST_USER_ID, OTHER_USER_ID),
      ).rejects.toBeInstanceOf(ValidationException);
    });

  });
});
