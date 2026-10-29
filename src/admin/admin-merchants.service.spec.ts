import { ConflictException } from 'src/common/errors/api.exception';
import { MerchantNotFoundException } from 'src/common/errors/not-found.exceptions';
import { LedgerUnavailableException } from 'src/common/errors/upstream.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import { AdminMerchantsService } from 'src/admin/admin-merchants.service';
import type { LedgerReadThroughService } from 'src/ledger/ledger-read-through.service';
import type { MerchantRepository } from 'src/merchants/merchant.repository';
import type { MerchantsService } from 'src/merchants/merchants.service';
import type { MerchantUserRepository } from 'src/merchants/users/merchant-user.repository';
import type { OnboardingService } from 'src/onboarding/onboarding.service';

import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The back office's merchant screens assemble other services' answers. What is asserted is the
 * assembly (summary rows carry onboarding state and owner email; a ledger outage degrades the
 * detail instead of failing it) and the one rule this service owns: the status route cannot be
 * used to skip review.
 */
describe('AdminMerchantsService', () => {
  const NOW = new Date('2026-05-02T11:30:00.000Z');

  function merchant(overrides: Record<string, unknown> = {}) {
    return {
      id: TEST_MERCHANT_ID,
      legalName: 'Acme Widgets Ltd',
      displayName: 'Acme',
      country: 'GB',
      defaultCurrency: 'GBP',
      status: 'active',
      mcc: '5999',
      riskTier: 'standard',
      payoutSchedule: 'daily',
      reserveBps: 0,
      reserveHoldDays: 0,
      pricingModel: 'blended',
      platformFeeBps: 290,
      platformFeeFixedMinor: 30,
      payoutDelayDays: 2,
      settlementToleranceMinor: 100,
      captureAtSettlement: false,
      livemode: true,
      metadata: {},
      toIsoCreatedAt: () => NOW.toISOString(),
      toIsoUpdatedAt: () => NOW.toISOString(),
      ...overrides,
    };
  }

  let merchants: { searchForStaff: jest.Mock; findById: jest.Mock };
  let users: { ownerEmailsFor: jest.Mock; listForMerchant: jest.Mock };
  let merchantsService: { changeStatus: jest.Mock };
  let onboarding: { rowsFor: jest.Mock; get: jest.Mock; bankAccountsFor: jest.Mock; decide: jest.Mock };
  let ledger: { getBalance: jest.Mock };
  let service: AdminMerchantsService;

  beforeEach(() => {
    merchants = {
      searchForStaff: jest.fn(async () => ({ data: [merchant()], has_more: false, next_cursor: null })),
      findById: jest.fn(async () => merchant()),
    };
    users = {
      ownerEmailsFor: jest.fn(async () => new Map([[TEST_MERCHANT_ID, 'owner@acme.example']])),
      listForMerchant: jest.fn(async () => [{ toUser: () => ({ id: 'usr_1', object: 'user' }) }]),
    };
    merchantsService = { changeStatus: jest.fn(async () => ({ id: TEST_MERCHANT_ID, status: 'restricted' })) };
    onboarding = {
      rowsFor: jest.fn(async () => new Map([[TEST_MERCHANT_ID, { state: 'submitted', submittedAt: NOW }]])),
      get: jest.fn(async () => ({ object: 'onboarding', state: 'submitted' })),
      bankAccountsFor: jest.fn(async () => [{ id: 'ba_1', object: 'bank_account' }]),
      decide: jest.fn(async () => undefined),
    };
    ledger = { getBalance: jest.fn(async () => ({ object: 'balance', currency: 'GBP' })) };

    service = new AdminMerchantsService(
      merchants as unknown as MerchantRepository,
      users as unknown as MerchantUserRepository,
      merchantsService as unknown as MerchantsService,
      onboarding as unknown as OnboardingService,
      ledger as unknown as LedgerReadThroughService,
      new NoopLogger(),
    );
  });

  it('lists merchants with their onboarding state and owner email', async () => {
    const page = await service.list({ status: 'active', onboarding_state: 'submitted', q: 'acme', limit: 10 });

    expect(merchants.searchForStaff).toHaveBeenCalledWith(
      { status: 'active', onboardingState: 'submitted', q: 'acme' },
      expect.objectContaining({ limit: 10 }),
    );
    expect(page.data[0]).toMatchObject({
      object: 'admin_merchant_summary',
      merchant: { id: TEST_MERCHANT_ID, object: 'merchant' },
      onboarding_state: 'submitted',
      submitted_at: NOW.toISOString(),
      owner_email: 'owner@acme.example',
    });
  });

  it('counts a merchant with no onboarding row as collecting', async () => {
    onboarding.rowsFor.mockResolvedValue(new Map());

    const page = await service.list({});

    expect(page.data[0]).toMatchObject({ onboarding_state: 'collecting', submitted_at: null });
  });

  it('assembles the detail: merchant, onboarding, users, bank accounts and the live balance', async () => {
    const detail = await service.detail(TEST_MERCHANT_ID);

    expect(ledger.getBalance).toHaveBeenCalledWith(TEST_MERCHANT_ID, 'GBP', true);
    expect(detail).toMatchObject({
      object: 'admin_merchant',
      onboarding: { state: 'submitted' },
      users: [{ id: 'usr_1' }],
      bank_accounts: [{ id: 'ba_1' }],
      balances: [{ object: 'balance' }],
    });
  });

  it('degrades the balance, not the page, when the ledger is down', async () => {
    ledger.getBalance.mockRejectedValue(new LedgerUnavailableException('GET /internal/v1/balances', 'timeout'));

    await expect(service.detail(TEST_MERCHANT_ID)).resolves.toMatchObject({ balances: [] });
  });

  it('404s an unknown merchant', async () => {
    merchants.findById.mockResolvedValue(null);

    await expect(service.detail(TEST_MERCHANT_ID)).rejects.toBeInstanceOf(MerchantNotFoundException);
  });

  it('decides through OnboardingService and answers the refreshed detail', async () => {
    const staff = { staffId: 'stf_1', ip: null };

    const detail = await service.decide(TEST_MERCHANT_ID, 'approve', null, staff);

    expect(onboarding.decide).toHaveBeenCalledWith(TEST_MERCHANT_ID, 'approve', null, staff);
    expect(detail.object).toBe('admin_merchant');
  });

  it('restricts through MerchantsService with the staff actor and reason', async () => {
    await service.changeStatus(TEST_MERCHANT_ID, { status: 'restricted', reason: 'chargebacks' }, 'stf_1');

    expect(merchantsService.changeStatus).toHaveBeenCalledWith(TEST_MERCHANT_ID, 'restricted', 'chargebacks', 'staff:stf_1');
  });

  it.each(['pending_review', 'rejected'])('refuses to move a %s merchant by status — that is review', async (status) => {
    merchants.findById.mockResolvedValue(merchant({ status }));

    const err = await service
      .changeStatus(TEST_MERCHANT_ID, { status: 'active', reason: 'skip review' }, 'stf_1')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(merchantsService.changeStatus).not.toHaveBeenCalled();
  });
});
