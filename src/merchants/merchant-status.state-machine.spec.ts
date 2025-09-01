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

  it('declares rejected and closed terminal, and nothing else', () => {
    for (const status of MERCHANT_STATUSES) {
      expect(machine.terminalStates.has(status)).toBe(status === 'rejected' || status === 'closed');
    }
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

});
