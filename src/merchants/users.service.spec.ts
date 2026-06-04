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
    it('over-fetches by one to decide has_more', async () => {
      await service.list(TEST_MERCHANT_ID, { limit: 25 });

      expect(users.listForMerchant).toHaveBeenCalledWith(TEST_MERCHANT_ID, 26);
    });

    it('reports has_more and trims the extra row', async () => {
      users.listForMerchant.mockResolvedValue([
        userRow({ id: 'usr_1' }),
        userRow({ id: 'usr_2' }),
        userRow({ id: 'usr_3' }),
      ]);

      const page = await service.list(TEST_MERCHANT_ID, { limit: 2 });

      expect(page.data).toHaveLength(2);
      expect(page.has_more).toBe(true);
    });

    it('returns a null cursor — this list is not cursor-paginated (PAY-1902)', async () => {
      const page = await service.list(TEST_MERCHANT_ID, { limit: 25 });

      expect(page.next_cursor).toBeNull();
    });
  });

  describe('get', () => {
    it('404s a user id that is not in this tenant', async () => {
      users.findByIdForMerchant.mockResolvedValue(null);

      await expect(service.get(TEST_MERCHANT_ID, TEST_USER_ID)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });
  });

  describe('invite', () => {
    it('creates the row as invited with an unusable password hash', async () => {
      await service.invite(TEST_MERCHANT_ID, input);

      const [row] = users.insertMapped.mock.calls[0];
      expect(row.status).toBe('invited');
      expect(row.passwordHash).toMatch(/^\$argon2/);
      expect(row.lastLoginAt).toBeNull();
    });

    it('mints a usr_-prefixed id and trims the display name', async () => {
      await service.invite(TEST_MERCHANT_ID, input);

      const [row] = users.insertMapped.mock.calls[0];
      expect(row.id).toMatch(/^usr_/);
      expect(row.fullName).toBe('New Person');
    });

    it('rejects an address that already has a login at this merchant', async () => {
      users.findByEmailForMerchant.mockResolvedValue(userRow());

      await expect(service.invite(TEST_MERCHANT_ID, input)).rejects.toBeInstanceOf(
        ValidationException,
      );
      expect(users.insertMapped).not.toHaveBeenCalled();
    });
  });

  describe('changeRole', () => {
    it('promotes without any owner check', async () => {
      users.findByIdForMerchant.mockResolvedValue(userRow({ role: 'developer' }));

      await service.changeRole(TEST_MERCHANT_ID, TEST_USER_ID, 'admin');

      expect(users.countOwners).not.toHaveBeenCalled();
      expect(users.updateRole).toHaveBeenCalledWith(TEST_MERCHANT_ID, TEST_USER_ID, 'admin');
    });

    it('refuses to demote the last owner', async () => {
      users.countOwners.mockResolvedValue(1);

      await expect(
        service.changeRole(TEST_MERCHANT_ID, TEST_USER_ID, 'viewer'),
      ).rejects.toBeInstanceOf(ValidationException);

      expect(users.updateRole).not.toHaveBeenCalled();
    });

    it('allows demoting an owner when another one remains', async () => {
      users.countOwners.mockResolvedValue(3);

      await service.changeRole(TEST_MERCHANT_ID, TEST_USER_ID, 'admin');

      expect(users.updateRole).toHaveBeenCalled();
    });

    it('404s an unknown user', async () => {
      users.findByIdForMerchant.mockResolvedValue(null);

      await expect(
        service.changeRole(TEST_MERCHANT_ID, TEST_USER_ID, 'viewer'),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });

  describe('remove', () => {
    it('disables rather than deleting — audit_log.actor_id points at these rows', async () => {
      users.findByIdForMerchant.mockResolvedValue(userRow({ id: OTHER_USER_ID, role: 'developer' }));

      await service.remove(TEST_MERCHANT_ID, OTHER_USER_ID, TEST_USER_ID);

      expect(users.disable).toHaveBeenCalledWith(TEST_MERCHANT_ID, OTHER_USER_ID);
    });

    it('refuses to let a user remove their own login', async () => {
      await expect(
        service.remove(TEST_MERCHANT_ID, TEST_USER_ID, TEST_USER_ID),
      ).rejects.toBeInstanceOf(PermissionDeniedException);

      expect(users.disable).not.toHaveBeenCalled();
    });

    it('refuses to remove the last owner', async () => {
      users.countOwners.mockResolvedValue(1);

      await expect(
        service.remove(TEST_MERCHANT_ID, TEST_USER_ID, OTHER_USER_ID),
      ).rejects.toBeInstanceOf(ValidationException);
    });

    it('404s an unknown user before any of the other checks', async () => {
      users.findByIdForMerchant.mockResolvedValue(null);

      await expect(
        service.remove(TEST_MERCHANT_ID, OTHER_USER_ID, TEST_USER_ID),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });
  });
});
