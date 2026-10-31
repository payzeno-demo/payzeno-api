import type { EntityManager } from 'typeorm';

import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { ApiConfig } from 'src/config/api-config.type';
import type { MerchantOnboardingService } from 'src/merchants/merchant-onboarding.service';
import type { MerchantUserTokensService } from 'src/merchants/users/user-tokens.service';
import type { MerchantUsersService } from 'src/merchants/users/users.service';
import type { EmailService } from 'src/notifications/email/email.service';
import type { OnboardingService } from 'src/onboarding/onboarding.service';
import { SELF_SERVE_MCC, SignupService } from 'src/onboarding/signup.service';

import { TEST_MERCHANT_ID } from 'test/factories/ids';

jest.mock('argon2', () => ({ argon2id: 2, hash: jest.fn(async (plain: string) => `hash:${plain}`) }));

/**
 * Signup is one transaction: the merchant (with both ledger charts — the seed's path), its
 * onboarding row, the `invited` owner holding the chosen password, the verification token and
 * the `signup_verify` email. Nobody is logged in until the link is clicked.
 */
describe('SignupService', () => {
  const manager = { tx: true } as unknown as EntityManager;
  const request = {
    email: ' Founder@Acme.example ',
    password: 'a-long-enough-password',
    full_name: 'Ada Founder',
    legal_name: 'Acme Widgets Ltd',
    display_name: 'Acme',
    country: 'gb',
    default_currency: 'GBP' as const,
  };

  let merchantOnboarding: { onboard: jest.Mock };
  let onboarding: { createFor: jest.Mock };
  let users: { createUser: jest.Mock };
  let tokens: { issue: jest.Mock };
  let email: { queue: jest.Mock };
  let service: SignupService;

  beforeEach(() => {
    merchantOnboarding = { onboard: jest.fn(async () => ({ id: TEST_MERCHANT_ID, displayName: 'Acme' })) };
    onboarding = { createFor: jest.fn(async () => undefined) };
    users = { createUser: jest.fn(async () => ({ id: 'usr_owner', merchantId: TEST_MERCHANT_ID })) };
    tokens = { issue: jest.fn(async () => 'verify-token') };
    email = { queue: jest.fn(async () => undefined) };

    service = new SignupService(
      merchantOnboarding as unknown as MerchantOnboardingService,
      onboarding as unknown as OnboardingService,
      users as unknown as MerchantUsersService,
      tokens as unknown as MerchantUserTokensService,
      email as unknown as EmailService,
      { runInTransaction: jest.fn((fn: (m: EntityManager) => Promise<unknown>) => fn(manager)) } as unknown as TransactionManager,
      { publicUrls: { console: 'http://console.test', admin: null } } as unknown as ApiConfig,
      new NoopLogger(),
    );
  });

  it('creates a live merchant pending review, with live and test charts, in one transaction', async () => {
    const response = await service.signup(request);

    expect(merchantOnboarding.onboard).toHaveBeenCalledWith(
      {
        legal_name: 'Acme Widgets Ltd',
        display_name: 'Acme',
        country: 'GB',
        default_currency: 'GBP',
        mcc: SELF_SERVE_MCC,
        metadata: { signup: 'self_serve' },
      },
      true,
      'signup',
      { manager, bootstrapTestMode: true },
    );
    expect(onboarding.createFor).toHaveBeenCalledWith(TEST_MERCHANT_ID, manager);
    expect(response).toEqual({ object: 'signup', merchant_id: TEST_MERCHANT_ID, verification_required: true });
  });

  it('creates the owner invited, holding the hash of the chosen password', async () => {
    await service.signup(request);

    expect(users.createUser).toHaveBeenCalledWith(
      TEST_MERCHANT_ID,
      { email: 'founder@acme.example', full_name: 'Ada Founder', role: 'owner' },
      { status: 'invited', passwordHash: 'hash:a-long-enough-password' },
      manager,
    );
  });

  it('emails signup_verify with the single-use link', async () => {
    await service.signup(request);

    expect(tokens.issue).toHaveBeenCalledWith({ id: 'usr_owner', merchantId: TEST_MERCHANT_ID }, 'email_verification', manager);
    expect(email.queue).toHaveBeenCalledWith(
      {
        template: 'signup_verify',
        to: 'founder@acme.example',
        data: { merchant_name: 'Acme', verify_url: 'http://console.test/verify-email?token=verify-token' },
        merchantId: TEST_MERCHANT_ID,
      },
      manager,
    );
  });

  it('creates nothing else when the merchant cannot be created (duplicate legal name, ledger down)', async () => {
    merchantOnboarding.onboard.mockRejectedValue(new Error('duplicate'));

    await expect(service.signup(request)).rejects.toThrow('duplicate');
    expect(users.createUser).not.toHaveBeenCalled();
    expect(email.queue).not.toHaveBeenCalled();
  });
});
