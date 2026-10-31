import type { EntityManager } from 'typeorm';

import { NoopLogger } from 'src/common/logging/logger';
import type { ApiConfig } from 'src/config/api-config.type';
import { MerchantMailerService } from 'src/merchants/merchant-mailer.service';
import type { MerchantRepository } from 'src/merchants/merchant.repository';
import type { MerchantUserRepository } from 'src/merchants/users/merchant-user.repository';
import type { EmailService } from 'src/notifications/email/email.service';

import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * "Tell the merchant" means every active owner and admin — and only them — with the merchant's
 * display name and a console link filled in, in the transaction the caller is holding.
 */
describe('MerchantMailerService', () => {
  const manager = { tx: true } as unknown as EntityManager;

  let merchants: { findById: jest.Mock };
  let users: { listActiveByRoles: jest.Mock };
  let email: { queue: jest.Mock };
  let service: MerchantMailerService;

  beforeEach(() => {
    merchants = { findById: jest.fn().mockResolvedValue({ id: TEST_MERCHANT_ID, displayName: 'Aurora Coffee' }) };
    users = {
      listActiveByRoles: jest.fn().mockResolvedValue([{ email: 'owner@aurora.example' }, { email: 'admin@aurora.example' }]),
    };
    email = { queue: jest.fn().mockResolvedValue(undefined) };
    service = new MerchantMailerService(
      merchants as unknown as MerchantRepository,
      users as unknown as MerchantUserRepository,
      email as unknown as EmailService,
      { publicUrls: { console: 'http://console.test', admin: null } } as unknown as ApiConfig,
      new NoopLogger(),
    );
  });

  it('queues one email per active owner and admin, in the caller transaction', async () => {
    const sent = await service.queueToAdmins(TEST_MERCHANT_ID, 'payout_paid', { amount: '$10.00' }, { manager });

    expect(sent).toBe(2);
    expect(users.listActiveByRoles).toHaveBeenCalledWith(TEST_MERCHANT_ID, ['owner', 'admin'], manager);
    expect(email.queue).toHaveBeenCalledWith(
      {
        template: 'payout_paid',
        to: 'owner@aurora.example',
        data: { merchant_name: 'Aurora Coffee', console_url: 'http://console.test', amount: '$10.00' },
        merchantId: TEST_MERCHANT_ID,
        livemode: true,
      },
      manager,
    );
    expect(email.queue.mock.calls[1][0].to).toBe('admin@aurora.example');
  });

  it('lets the caller override the defaults it fills in', async () => {
    await service.queueToAdmins(TEST_MERCHANT_ID, 'dispute_opened', { console_url: 'http://console.test/disputes/dp_1' });

    expect(email.queue.mock.calls[0][0].data.console_url).toBe('http://console.test/disputes/dp_1');
  });

  it('sends nothing, and does not throw, when nobody is there to tell', async () => {
    users.listActiveByRoles.mockResolvedValue([]);

    await expect(service.queueToAdmins(TEST_MERCHANT_ID, 'payout_failed', {})).resolves.toBe(0);
    expect(email.queue).not.toHaveBeenCalled();
  });

  it('builds console links off CONSOLE_PUBLIC_URL', () => {
    expect(service.consoleLink('/onboarding')).toBe('http://console.test/onboarding');
    expect(service.consoleLink('disputes/dp_1')).toBe('http://console.test/disputes/dp_1');
  });
});
