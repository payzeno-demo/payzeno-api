import type { EntityManager } from 'typeorm';

import { MerchantNotFoundException } from 'src/common/errors/not-found.exceptions';
import { InvalidMerchantTransitionException } from 'src/common/errors/state.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import type { EventPublisher } from 'src/events/publisher';
import type { MerchantOnboardingService } from 'src/merchants/merchant-onboarding.service';
import { MerchantStatusStateMachine } from 'src/merchants/merchant-status.state-machine';
import type { MerchantRepository } from 'src/merchants/merchant.repository';
import {
  MerchantsService,
  STAFF_ONLY_MERCHANT_FIELDS,
  toMerchantResponse,
} from 'src/merchants/merchants.service';

import { TEST_MERCHANT_ID } from 'test/factories/ids';
import { FixedClock } from 'test/support/fixed-clock';

/**
 * The two behaviours worth a spec are both about things OUTSIDE this service.
 *
 *   `update()` emitting `merchant.updated` with the full mutable field set is the ONLY path
 *   by which `merchant_projection.capture_at_settlement` can ever change in payzeno-ledger.
 *   Drop the emit and migration 0013's column can be added and never set.
 *
 *   `changeStatus()` is a conditional UPDATE, not a read-then-write. Two staff operators
 *   clicking "suspend" and "reinstate" a second apart must not leave an active merchant with
 *   a suspension in the audit log — the loser affects zero rows and gets the 409.
 */
describe('MerchantsService', () => {
  const clock = new FixedClock('2026-03-14T09:21:07.412Z');

  function row(overrides: Record<string, unknown> = {}) {
    return {
      id: TEST_MERCHANT_ID,
      legalName: 'Aurora Coffee Roasters Ltd',
      displayName: 'Aurora Coffee',
      country: 'GB',
      defaultCurrency: 'GBP',
      status: 'active',
      mcc: '5812',
      riskTier: 'standard',
      payoutSchedule: 'daily',
      pricingModel: 'blended',
      reserveBps: 0,
      reserveHoldDays: 0,
      platformFeeBps: 290,
      platformFeeFixedMinor: 30,
      payoutDelayDays: 2,
      settlementToleranceMinor: 100,
      captureAtSettlement: false,
      statementDescriptor: 'AURORA COFFEE',
      livemode: true,
      metadata: {},
      toIsoCreatedAt: () => '2026-01-02T08:00:00.000Z',
      toIsoUpdatedAt: () => '2026-03-14T09:21:07.412Z',
      ...overrides,
    };
  }

  let merchants: {
    findById: jest.Mock;
    applyPatch: jest.Mock;
    transitionStatus: jest.Mock;
    listForStaff: jest.Mock;
  };
  let onboarding: { onboard: jest.Mock };
  let transactions: TransactionManager;
  let events: { publish: jest.Mock };
  let service: MerchantsService;

  beforeEach(() => {
    merchants = {
      findById: jest.fn().mockResolvedValue(row()),
      applyPatch: jest.fn().mockResolvedValue(1),
      transitionStatus: jest.fn().mockResolvedValue(1),
      listForStaff: jest.fn().mockResolvedValue({ data: [row()], has_more: false, next_cursor: null }),
    };
    onboarding = { onboard: jest.fn().mockResolvedValue(row({ status: 'pending_review' })) };
    events = { publish: jest.fn().mockResolvedValue(undefined) };

    transactions = {
      runInTransaction: jest.fn(async (cb: (m: EntityManager) => Promise<unknown>) =>
        cb({} as EntityManager),
      ),
    } as unknown as TransactionManager;

    service = new MerchantsService(
      merchants as unknown as MerchantRepository,
      onboarding as unknown as MerchantOnboardingService,
      new MerchantStatusStateMachine(),
      transactions,
      events as unknown as EventPublisher,
      clock,
      new NoopLogger(),
    );
  });

  it('names the aggregate for the 404 message and audit_log.resource_type', () => {
    expect(service.entityName).toBe('merchant');
  });

  describe('create', () => {
    it('delegates the whole multi-aggregate write to the onboarding service', async () => {
      const created = await service.create(
        {
          legal_name: 'Aurora Coffee Roasters Ltd',
          display_name: 'Aurora Coffee',
          country: 'GB',
          default_currency: 'GBP',
          mcc: '5812',
        },
        true,
        'stf_operator',
      );

      expect(onboarding.onboard).toHaveBeenCalledWith(
        expect.objectContaining({ legal_name: 'Aurora Coffee Roasters Ltd' }),
        true,
        'stf_operator',
      );
      expect(created.object).toBe('merchant');
      expect(created.status).toBe('pending_review');
    });
  });

  describe('getById', () => {
    it('returns the row', async () => {
      await expect(service.getById(TEST_MERCHANT_ID)).resolves.toMatchObject({
        id: TEST_MERCHANT_ID,
      });
    });

    it('404s with the merchant-specific subclass', async () => {
      merchants.findById.mockResolvedValue(null);

      await expect(service.getById(TEST_MERCHANT_ID)).rejects.toBeInstanceOf(
        MerchantNotFoundException,
      );
    });
  });

  describe('findInternal', () => {
    it('returns null instead of throwing — a duplicate against a closed merchant is a log line', async () => {
      merchants.findById.mockResolvedValue(null);

      await expect(service.findInternal(TEST_MERCHANT_ID)).resolves.toBeNull();
    });
  });

  describe('update', () => {
    it('writes only the keys the request actually carried', async () => {
      await service.update(TEST_MERCHANT_ID, { display_name: 'Aurora' }, 'usr_owner');

      expect(merchants.applyPatch).toHaveBeenCalledWith(
        TEST_MERCHANT_ID,
        { displayName: 'Aurora' },
        expect.anything(),
      );
    });

    it('emits merchant.updated with the full mutable field set, not a diff', async () => {
      merchants.findById.mockResolvedValue(row({ captureAtSettlement: true }));

      await service.update(TEST_MERCHANT_ID, { display_name: 'Aurora' }, 'usr_owner');

      const [type, payload] = events.publish.mock.calls[0];
      expect(type).toBe('merchant.updated');
      // The one field payzeno-ledger has no other way to learn about.
      expect(payload).toMatchObject({
        merchant_id: TEST_MERCHANT_ID,
        capture_at_settlement: true,
        reserve_bps: 0,
        payout_delay_days: 2,
        settlement_tolerance_minor: 100,
        changed_by: 'usr_owner',
      });
    });

    it('publishes inside the caller’s transaction', async () => {
      await service.update(TEST_MERCHANT_ID, { payout_schedule: 'weekly' }, 'usr_owner');

      expect(transactions.runInTransaction).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledTimes(1);
    });

    it('404s when the conditional update affects nothing', async () => {
      merchants.applyPatch.mockResolvedValue(0);

      await expect(
        service.update(TEST_MERCHANT_ID, { display_name: 'Gone' }, 'usr_owner'),
      ).rejects.toBeInstanceOf(MerchantNotFoundException);
    });

    it('translates every staff-only field to its column name', async () => {
      await service.update(
        TEST_MERCHANT_ID,
        {
          risk_tier: 'elevated',
          reserve_bps: 500,
          reserve_hold_days: 90,
          payout_delay_days: 7,
          platform_fee_bps: 320,
          platform_fee_fixed_minor: 25,
          settlement_tolerance_minor: 250,
          capture_at_settlement: true,
        },
        'stf_risk',
      );

      expect(merchants.applyPatch).toHaveBeenCalledWith(
        TEST_MERCHANT_ID,
        {
          riskTier: 'elevated',
          reserveBps: 500,
          reserveHoldDays: 90,
          payoutDelayDays: 7,
          platformFeeBps: 320,
          platformFeeFixedMinor: 25,
          settlementToleranceMinor: 250,
          captureAtSettlement: true,
        },
        expect.anything(),
      );
    });
  });

  describe('changeStatus', () => {
    it('runs the transition through the state machine before writing', async () => {
      merchants.findById.mockResolvedValue(row({ status: 'active' }));

      await service.changeStatus(TEST_MERCHANT_ID, 'restricted', 'dispute rate', 'stf_risk');

      expect(merchants.transitionStatus).toHaveBeenCalledWith(
        TEST_MERCHANT_ID,
        'active',
        'restricted',
        expect.anything(),
      );
    });

    it('refuses an illegal target without touching the database', async () => {
      merchants.findById.mockResolvedValue(row({ status: 'closed' }));

      await expect(
        service.changeStatus(TEST_MERCHANT_ID, 'active', 'oops', 'stf_admin'),
      ).rejects.toBeInstanceOf(InvalidMerchantTransitionException);

      expect(merchants.transitionStatus).not.toHaveBeenCalled();
    });

    it('turns a lost race — zero rows affected — into the same 409', async () => {
      merchants.transitionStatus.mockResolvedValue(0);

      await expect(
        service.changeStatus(TEST_MERCHANT_ID, 'suspended', 'fraud', 'stf_risk'),
      ).rejects.toBeInstanceOf(InvalidMerchantTransitionException);
    });

    it('emits merchant.status_changed carrying both the previous and the new status', async () => {
      await service.changeStatus(TEST_MERCHANT_ID, 'suspended', 'fraud review', 'stf_risk');

      const [type, payload] = events.publish.mock.calls[0];
      expect(type).toBe('merchant.status_changed');
      expect(payload).toMatchObject({
        previous_status: 'active',
        status: 'suspended',
        reason: 'fraud review',
        changed_by: 'stf_risk',
      });
    });
  });

  describe('restrictForRisk', () => {
    it('goes through changeStatus so the event and the audit row still happen', async () => {
      await service.restrictForRisk(TEST_MERCHANT_ID, 137);

      const [type, payload] = events.publish.mock.calls[0];
      expect(type).toBe('merchant.status_changed');
      expect(payload).toMatchObject({
        status: 'restricted',
        changed_by: 'system:risk_evaluation',
      });
      expect(String(payload.reason)).toContain('137 bps');
    });
  });

  describe('listForStaff', () => {
    it('maps rows to the wire shape and preserves the page envelope', async () => {
      const page = await service.listForStaff({ limit: 10 }, 'active');

      expect(merchants.listForStaff).toHaveBeenCalledWith({ limit: 10 }, 'active');
      expect(page.has_more).toBe(false);
      expect(page.data[0].object).toBe('merchant');
    });
  });

  describe('toMerchantResponse', () => {
    it('coerces the bigint columns to numbers so JSON does not emit strings', () => {
      const wire = toMerchantResponse(
        row({ platformFeeFixedMinor: '30', settlementToleranceMinor: '100' }) as never,
      );

      expect(wire.platform_fee_fixed_minor).toBe(30);
      expect(wire.settlement_tolerance_minor).toBe(100);
    });

    it('defaults absent metadata to an empty object rather than null', () => {
      expect(toMerchantResponse(row({ metadata: null }) as never).metadata).toEqual({});
    });
  });

  it('declares every staff-gated field so the controller can 403 a merchant PATCH', () => {
    expect(STAFF_ONLY_MERCHANT_FIELDS).toEqual(
      expect.arrayContaining([
        'risk_tier',
        'reserve_bps',
        'reserve_hold_days',
        'payout_delay_days',
        'platform_fee_bps',
        'platform_fee_fixed_minor',
        'settlement_tolerance_minor',
        'capture_at_settlement',
      ]),
    );
    expect(STAFF_ONLY_MERCHANT_FIELDS).not.toContain('display_name');
  });
});
