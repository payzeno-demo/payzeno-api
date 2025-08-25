import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { ChargeStateMachine } from 'src/payments/state/charge.state-machine';
import { PaymentIntentStateMachine } from 'src/payments/state/payment-intent.state-machine';
import { StateMachine } from 'src/payments/state/state-machine';
import { DisputeStateMachine } from 'src/disputes/state/dispute.state-machine';
import { MerchantStatusStateMachine } from 'src/merchants/merchant-status.state-machine';
import { RefundStateMachine } from 'src/refunds/state/refund.state-machine';
import { WebhookDeliveryStateMachine } from 'src/webhooks/state/webhook-delivery.state-machine';

/**
 * The base-class contract, driven table-style over all six concrete machines
 * (blueprint §10 — this is the file that produces a `TESTS` edge to every FSM in the
 * repo, not just to `StateMachine`).
 *
 * `StateMachine.apply` is the single throw site for `InvalidStateTransitionException`,
 * reached from six machines. If any machine reimplements `apply`, one of the rows below
 * stops throwing and this file says which one.
 */

interface MachineCase {
  name: string;
  machine: StateMachine<string, string>;
  start: string;
  legalEvent: string;
  legalResult: string;
  illegalEvent: string;
  terminal: string;
}

const machines: MachineCase[] = [
  {
    name: 'PaymentIntentStateMachine',
    machine: new PaymentIntentStateMachine() as unknown as StateMachine<string, string>,
    start: 'requires_confirmation',
    legalEvent: 'confirm',
    legalResult: 'processing',
    illegalEvent: 'capture',
    terminal: 'canceled',
  },
  {
    name: 'ChargeStateMachine',
    machine: new ChargeStateMachine() as unknown as StateMachine<string, string>,
    start: 'authorized',
    legalEvent: 'capture',
    legalResult: 'captured',
    illegalEvent: 'settle',
    terminal: 'reversed',
  },
  {
    name: 'RefundStateMachine',
    machine: new RefundStateMachine() as unknown as StateMachine<string, string>,
    start: 'pending',
    legalEvent: 'succeed',
    legalResult: 'succeeded',
    illegalEvent: 'cancel_settled',
    terminal: 'succeeded',
  },
  {
    name: 'DisputeStateMachine',
    machine: new DisputeStateMachine() as unknown as StateMachine<string, string>,
    start: 'needs_response',
    legalEvent: 'submit_evidence',
    legalResult: 'under_review',
    illegalEvent: 'reopen',
    terminal: 'won',
  },
  {
    name: 'WebhookDeliveryStateMachine',
    machine: new WebhookDeliveryStateMachine() as unknown as StateMachine<string, string>,
    start: 'pending',
    legalEvent: 'attempt',
    legalResult: 'delivering',
    illegalEvent: 'exhaust',
    terminal: 'delivered',
  },
  {
    name: 'MerchantStatusStateMachine',
    machine: new MerchantStatusStateMachine() as unknown as StateMachine<string, string>,
    start: 'pending_review',
    legalEvent: 'approve',
    legalResult: 'active',
    illegalEvent: 'restrict',
    terminal: 'closed',
  },
];

describe('StateMachine', () => {
  describe.each(machines)('$name', (c) => {
    it('permits a legal transition', () => {
      expect(c.machine.can(c.start, c.legalEvent)).toBe(true);
      expect(c.machine.apply(c.start, c.legalEvent)).toBe(c.legalResult);
    });

    it('refuses an illegal transition', () => {
      expect(c.machine.can(c.start, c.illegalEvent)).toBe(false);
    });

    it('throws InvalidStateTransitionException — not a bare Error — on an illegal event', () => {
      expect(() => c.machine.apply(c.start, c.illegalEvent)).toThrow(
        InvalidStateTransitionException,
      );
    });

    it('names both the state and the event in the thrown message', () => {
      try {
        c.machine.apply(c.start, c.illegalEvent);
        throw new Error('expected apply() to throw');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain(c.start);
        expect(message).toContain(c.illegalEvent);
      }
    });

    it('declares at least one terminal state', () => {
      expect(c.machine.terminalStates.size).toBeGreaterThan(0);
      expect(c.machine.terminalStates.has(c.terminal)).toBe(true);
    });

    it('assertNotTerminal passes for a live state and throws for a terminal one', () => {
      expect(() => c.machine.assertNotTerminal(c.start)).not.toThrow();
      expect(() => c.machine.assertNotTerminal(c.terminal)).toThrow(
        InvalidStateTransitionException,
      );
    });

    it('has no event leaving a terminal state', () => {
      for (const terminal of c.machine.terminalStates) {
        const transitions = (
          c.machine as unknown as { transitions: Record<string, Record<string, string>> }
        ).transitions;
        expect(Object.keys(transitions[terminal] ?? {})).toEqual([]);
      }
    });

    it('is idempotent — `can` does not mutate the machine', () => {
      const before = c.machine.can(c.start, c.legalEvent);
      c.machine.can(c.start, c.illegalEvent);
      expect(c.machine.can(c.start, c.legalEvent)).toBe(before);
    });
  });

  it('covers all six machines the blueprint names', () => {
    expect(machines).toHaveLength(6);
  });
});
