import type { MerchantStatus } from '@payzeno/contracts';
import { MERCHANT_STATUSES } from '@payzeno/contracts';

import { InvalidMerchantTransitionException } from 'src/common/errors/state.exceptions';
import {
  MerchantStatusStateMachine,
  type MerchantStatusEvent,
} from 'src/merchants/merchant-status.state-machine';

/**
 * domain-model.md §1, as a table.
 *
 * The distinction this spec is really protecting is `restricted` vs `suspended`. `restricted`
 * is set automatically by `RiskEvaluationService` and means "may charge, may not be paid
 * out"; it is reversible without a human. `suspended` is the human decision and stops
 * charging too. Collapsing them would either freeze merchants a job restricted overnight or
 * keep paying out to one a risk operator suspended by hand.
 */
describe('MerchantStatusStateMachine', () => {
  const machine = new MerchantStatusStateMachine();

  describe.each<[MerchantStatus, MerchantStatusEvent, MerchantStatus]>([
    ['pending_review', 'approve', 'active'],
    ['pending_review', 'reject', 'rejected'],
    ['pending_review', 'close', 'closed'],
    ['active', 'restrict', 'restricted'],
    ['active', 'suspend', 'suspended'],
    ['active', 'close', 'closed'],
    ['restricted', 'reinstate', 'active'],
    ['restricted', 'suspend', 'suspended'],
    ['restricted', 'close', 'closed'],
    ['suspended', 'reinstate', 'active'],
    ['suspended', 'close', 'closed'],
  ])('%s --%s-->', (from, event, to) => {
    it(`is ${to}`, () => {
      expect(machine.apply(from, event)).toBe(to);
    });
  });

  describe.each<[MerchantStatus, MerchantStatusEvent]>([
    ['pending_review', 'restrict'],
    ['pending_review', 'reinstate'],
    ['pending_review', 'suspend'],
    ['active', 'approve'],
    ['active', 'reject'],
    ['active', 'reinstate'],
    ['restricted', 'approve'],
    ['restricted', 'restrict'],
    ['suspended', 'restrict'],
    ['rejected', 'approve'],
    ['rejected', 'reinstate'],
    ['closed', 'reinstate'],
    ['closed', 'approve'],
  ])('%s --%s-->', (from, event) => {
    it('raises InvalidMerchantTransitionException', () => {
      expect(() => machine.apply(from, event)).toThrow(InvalidMerchantTransitionException);
    });
  });

  it('raises the merchant-specific subclass, not the generic one', () => {
    try {
      machine.apply('closed', 'approve');
      throw new Error('expected an InvalidMerchantTransitionException');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidMerchantTransitionException);
      expect((err as InvalidMerchantTransitionException).httpStatus).toBe(409);
    }
  });

  it('declares rejected and closed terminal, and nothing else', () => {
    for (const status of MERCHANT_STATUSES) {
      expect(machine.terminalStates.has(status)).toBe(status === 'rejected' || status === 'closed');
    }
  });

  it('leaves every terminal state with no outgoing event', () => {
    for (const status of machine.terminalStates) {
      const events: MerchantStatusEvent[] = [
        'approve',
        'reject',
        'restrict',
        'reinstate',
        'suspend',
        'close',
      ];
      for (const event of events) {
        expect(() => machine.apply(status, event)).toThrow(InvalidMerchantTransitionException);
      }
    }
  });

  describe('eventFor', () => {
    it('translates the console’s "put this merchant in state X" into the event', () => {
      expect(machine.eventFor('active', 'restricted')).toBe('restrict');
      expect(machine.eventFor('restricted', 'active')).toBe('reinstate');
      expect(machine.eventFor('pending_review', 'active')).toBe('approve');
      expect(machine.eventFor('active', 'closed')).toBe('close');
    });

    it('refuses a target the table has no edge to', () => {
      expect(() => machine.eventFor('active', 'pending_review')).toThrow(
        InvalidMerchantTransitionException,
      );
      expect(() => machine.eventFor('closed', 'active')).toThrow(InvalidMerchantTransitionException);
    });

    it('round-trips with apply for every legal edge', () => {
      const pairs: Array<[MerchantStatus, MerchantStatus]> = [
        ['pending_review', 'active'],
        ['active', 'suspended'],
        ['suspended', 'active'],
        ['restricted', 'closed'],
      ];

      for (const [from, to] of pairs) {
        expect(machine.apply(from, machine.eventFor(from, to))).toBe(to);
      }
    });
  });

  describe('isFrozen', () => {
    it('is true for the statuses that stop money moving in either direction', () => {
      expect(machine.isFrozen('suspended')).toBe(true);
      expect(machine.isFrozen('closed')).toBe(true);
      expect(machine.isFrozen('rejected')).toBe(true);
    });

    it('is false for restricted — a restricted merchant may still charge', () => {
      expect(machine.isFrozen('restricted')).toBe(false);
      expect(machine.isFrozen('active')).toBe(false);
      expect(machine.isFrozen('pending_review')).toBe(false);
    });
  });

  it('names the aggregate so InvalidStateTransitionException details are attributable', () => {
    expect(machine.entity).toBe('merchant');
  });
});
