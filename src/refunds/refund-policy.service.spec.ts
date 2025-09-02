import type { EntityManager } from 'typeorm';

import { ChargeNotFoundException } from 'src/common/errors/not-found.exceptions';
import {
  RefundAmountExceededException,
  RefundWindowClosedException,
} from 'src/common/errors/business.exceptions';
import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import { ChargeRepository } from 'src/payments/charge.repository';
import { ChargeStateMachine } from 'src/payments/state/charge.state-machine';
import { RefundPolicyService } from 'src/refunds/refund-policy.service';
import { RefundRepository } from 'src/refunds/refund.repository';

import { FixedClock } from 'test/support/fixed-clock';
import { TEST_CHARGE_ID } from 'test/factories/ids';

/**
 * The refund gate. Every throw here is a 4xx the merchant can act on, which is why the
 * cases below are all about *which* exception, not merely that one was thrown.
 *
 * The rule that catches people: an `authorized` charge takes a void, not a refund. A void
 * is a different network call with different interchange treatment and no cardholder-
 * visible credit, so `POST /v1/refunds` against one is rejected rather than silently
 * turned into a cancel (domain-model §4).
 */
describe('RefundPolicyService', () => {
  let charges: jest.Mocked<ChargeRepository>;
  let refunds: jest.Mocked<RefundRepository>;
  let clock: FixedClock;
  let policy: RefundPolicyService;

  const manager = {} as EntityManager;

  function chargeRow(overrides: Record<string, unknown> = {}) {
    return {
      id: TEST_CHARGE_ID,
      status: 'captured',
      currency: 'GBP',
      amount_minor: 4_500,
      captured_amount_minor: 4_500,
      captured_at: new Date('2026-01-10T10:00:00.000Z'),
      authorized_at: new Date('2026-01-10T09:59:00.000Z'),
      ...overrides,
    };
  }

  beforeEach(() => {
    charges = { lockForUpdate: jest.fn() } as unknown as jest.Mocked<ChargeRepository>;
    refunds = {
      sumRefundedForCharge: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<RefundRepository>;
    clock = new FixedClock('2026-01-15T12:00:00.000Z');
    policy = new RefundPolicyService(
      charges,
      refunds,
      new ChargeStateMachine(),
      clock,
      new NoopLogger(),
    );
  });

  it('takes a row lock before deciding anything', async () => {
    charges.lockForUpdate.mockResolvedValue(chargeRow() as never);

    await policy.evaluate(manager, TEST_CHARGE_ID, 1_000, 'duplicate');

    expect(charges.lockForUpdate).toHaveBeenCalledWith(TEST_CHARGE_ID, manager);
  });

  it('throws ChargeNotFoundException for an unknown charge', async () => {
    charges.lockForUpdate.mockResolvedValue(null as never);

    await expect(
      policy.evaluate(manager, 'ch_missing', 1_000, undefined),
    ).rejects.toBeInstanceOf(ChargeNotFoundException);
  });

  describe('status', () => {
    it('accepts a captured charge', async () => {
      charges.lockForUpdate.mockResolvedValue(chargeRow() as never);

      const decision = await policy.evaluate(manager, TEST_CHARGE_ID, 1_000, undefined);

      expect(decision.amountMinor).toBe(1_000);
      expect(decision.netsAgainstSettlement).toBe(true);
    });

    it('accepts a settled charge but marks it as no longer netting against settlement', async () => {
      charges.lockForUpdate.mockResolvedValue(chargeRow({ status: 'settled' }) as never);

      const decision = await policy.evaluate(manager, TEST_CHARGE_ID, 1_000, undefined);

      expect(decision.netsAgainstSettlement).toBe(false);
    });

    it('rejects an authorized charge and says to cancel instead', async () => {
      charges.lockForUpdate.mockResolvedValue(
        chargeRow({ status: 'authorized', captured_at: null }) as never,
      );

      try {
        await policy.evaluate(manager, TEST_CHARGE_ID, 1_000, undefined);
        throw new Error('expected a rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidStateTransitionException);
        expect((err as Error).message).toContain('cancel the payment intent');
      }
    });

    it.each(['failed', 'voided', 'expired', 'pending'])('rejects a %s charge', async (status) => {
      charges.lockForUpdate.mockResolvedValue(chargeRow({ status }) as never);

      await expect(
        policy.evaluate(manager, TEST_CHARGE_ID, 1_000, undefined),
      ).rejects.toBeInstanceOf(InvalidStateTransitionException);
    });
  });

  describe('the refund window', () => {
    it('accepts a charge captured today', async () => {
      charges.lockForUpdate.mockResolvedValue(
        chargeRow({ captured_at: new Date('2026-01-15T09:00:00.000Z') }) as never,
      );

      await expect(policy.evaluate(manager, TEST_CHARGE_ID, 500, undefined)).resolves.toBeDefined();
    });

    it('accepts a charge captured one day inside the window', async () => {
      charges.lockForUpdate.mockResolvedValue(
        chargeRow({ captured_at: new Date('2025-07-21T12:00:00.000Z') }) as never,
      );

      await expect(policy.evaluate(manager, TEST_CHARGE_ID, 500, undefined)).resolves.toBeDefined();
    });

    it('rejects a charge past the window', async () => {
      charges.lockForUpdate.mockResolvedValue(
        chargeRow({ captured_at: new Date('2025-01-01T12:00:00.000Z') }) as never,
      );

      await expect(
        policy.evaluate(manager, TEST_CHARGE_ID, 500, undefined),
      ).rejects.toBeInstanceOf(RefundWindowClosedException);
    });

    it('falls back to authorized_at when there is no capture timestamp', async () => {
      charges.lockForUpdate.mockResolvedValue(
        chargeRow({ captured_at: null, authorized_at: new Date('2026-01-14T12:00:00.000Z') }) as never,
      );

      await expect(policy.evaluate(manager, TEST_CHARGE_ID, 500, undefined)).resolves.toBeDefined();
    });

    it('closes the window on a pre-migration-07 row with no timestamps at all', async () => {
      charges.lockForUpdate.mockResolvedValue(
        chargeRow({ captured_at: null, authorized_at: null }) as never,
      );

      await expect(
        policy.evaluate(manager, TEST_CHARGE_ID, 500, undefined),
      ).rejects.toBeInstanceOf(RefundWindowClosedException);
    });

    it('moves with the clock', async () => {
      charges.lockForUpdate.mockResolvedValue(
        chargeRow({ captured_at: new Date('2026-01-10T10:00:00.000Z') }) as never,
      );

      await expect(policy.evaluate(manager, TEST_CHARGE_ID, 500, undefined)).resolves.toBeDefined();

      clock.advanceDays(200);
      await expect(
        policy.evaluate(manager, TEST_CHARGE_ID, 500, undefined),
      ).rejects.toBeInstanceOf(RefundWindowClosedException);
    });
  });

  describe('amount', () => {
    it('defaults to the full remaining refundable amount', async () => {
      charges.lockForUpdate.mockResolvedValue(chargeRow() as never);
      refunds.sumRefundedForCharge.mockResolvedValue(1_500 as never);

      const decision = await policy.evaluate(manager, TEST_CHARGE_ID, undefined, undefined);

      expect(decision.amountMinor).toBe(3_000);
    });

    it('accepts a partial refund', async () => {
      charges.lockForUpdate.mockResolvedValue(chargeRow() as never);

      const decision = await policy.evaluate(manager, TEST_CHARGE_ID, 1_000, undefined);

      expect(decision.amountMinor).toBe(1_000);
    });

    it('accepts exactly the remaining amount', async () => {
      charges.lockForUpdate.mockResolvedValue(chargeRow() as never);
      refunds.sumRefundedForCharge.mockResolvedValue(4_000 as never);

      await expect(
        policy.evaluate(manager, TEST_CHARGE_ID, 500, undefined),
      ).resolves.toMatchObject({ amountMinor: 500 });
    });

    it('rejects more than the remaining amount', async () => {
      charges.lockForUpdate.mockResolvedValue(chargeRow() as never);
      refunds.sumRefundedForCharge.mockResolvedValue(4_000 as never);

      await expect(
        policy.evaluate(manager, TEST_CHARGE_ID, 1_000, undefined),
      ).rejects.toBeInstanceOf(RefundAmountExceededException);
    });

    it('rejects a fully-refunded charge', async () => {
      charges.lockForUpdate.mockResolvedValue(chargeRow() as never);
      refunds.sumRefundedForCharge.mockResolvedValue(4_500 as never);

      await expect(
        policy.evaluate(manager, TEST_CHARGE_ID, undefined, undefined),
      ).rejects.toBeInstanceOf(RefundAmountExceededException);
    });

    it('refunds against captured_amount_minor, not amount_minor', async () => {
      // A partial capture leaves the rest of the authorisation unclaimed; refunding it
      // would credit money that was never taken.
      charges.lockForUpdate.mockResolvedValue(
        chargeRow({ amount_minor: 4_500, captured_amount_minor: 2_000 }) as never,
      );

      await expect(
        policy.evaluate(manager, TEST_CHARGE_ID, 2_500, undefined),
      ).rejects.toBeInstanceOf(RefundAmountExceededException);
    });
  });

  describe('reason', () => {
    it('defaults to requested_by_customer', async () => {
      charges.lockForUpdate.mockResolvedValue(chargeRow() as never);

      const decision = await policy.evaluate(manager, TEST_CHARGE_ID, 500, undefined);

      expect(decision.reason).toBe('requested_by_customer');
    });

    it('keeps the supplied reason', async () => {
      charges.lockForUpdate.mockResolvedValue(chargeRow() as never);

      const decision = await policy.evaluate(manager, TEST_CHARGE_ID, 500, 'fraudulent');

      expect(decision.reason).toBe('fraudulent');
    });
  });

  describe('refundableAmount', () => {
    it('reports what is left without taking a lock', async () => {
      const findOneBy = jest.fn().mockResolvedValue(chargeRow());
      refunds.sumRefundedForCharge.mockResolvedValue(1_000 as never);

      const remaining = await policy.refundableAmount(TEST_CHARGE_ID, {
        findOneBy,
      } as unknown as EntityManager);

      expect(remaining).toBe(3_500);
      expect(charges.lockForUpdate).not.toHaveBeenCalled();
    });

    it('reports zero for an unknown charge', async () => {
      const findOneBy = jest.fn().mockResolvedValue(null);

      await expect(
        policy.refundableAmount('ch_missing', { findOneBy } as unknown as EntityManager),
      ).resolves.toBe(0);
    });

    it('never reports a negative amount', async () => {
      const findOneBy = jest.fn().mockResolvedValue(chargeRow({ captured_amount_minor: 1_000 }));
      refunds.sumRefundedForCharge.mockResolvedValue(2_000 as never);

      await expect(
        policy.refundableAmount(TEST_CHARGE_ID, { findOneBy } as unknown as EntityManager),
      ).resolves.toBe(0);
    });
  });
});
