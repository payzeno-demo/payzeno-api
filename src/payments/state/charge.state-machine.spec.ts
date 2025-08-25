import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { ChargeStateMachine } from 'src/payments/state/charge.state-machine';

/**
 * `Charge` has eight statuses and only one of them is reached from outside payzeno-api:
 * `settled`, driven by the ledger. That asymmetry is why `settle` is legal only from
 * `captured` — a `settled` event on an `authorized` charge means a settlement file
 * matched a line we never captured, and swallowing it is how PAY-2041 stayed invisible.
 */
describe('ChargeStateMachine', () => {
  let fsm: ChargeStateMachine;

  beforeEach(() => {
    fsm = new ChargeStateMachine();
  });

  it('pending → authorized on approval', () => {
    expect(fsm.apply('pending', 'authorize')).toBe('authorized');
  });

  it('pending → failed on decline', () => {
    expect(fsm.apply('pending', 'decline')).toBe('failed');
  });

  it('authorized → captured on capture', () => {
    expect(fsm.apply('authorized', 'capture')).toBe('captured');
  });

  it('authorized → voided on a void', () => {
    expect(fsm.apply('authorized', 'void')).toBe('voided');
  });

  it('authorized → expired when the auth hold lapses', () => {
    expect(fsm.apply('authorized', 'expire')).toBe('expired');
  });

  it('captured → settled when the ledger reconciles the batch', () => {
    expect(fsm.apply('captured', 'settle')).toBe('settled');
  });

  it('settled → reversed on a chargeback that takes the money back', () => {
    expect(fsm.apply('settled', 'reverse')).toBe('reversed');
  });

  describe('the transitions that must NOT exist', () => {
    it('refuses to settle a charge that was never captured', () => {
      expect(fsm.can('authorized', 'settle')).toBe(false);
      expect(() => fsm.apply('authorized', 'settle')).toThrow(InvalidStateTransitionException);
    });

    it('refuses to capture an expired authorisation', () => {
      expect(fsm.can('expired', 'capture')).toBe(false);
    });

    it('refuses to capture twice', () => {
      expect(fsm.can('captured', 'capture')).toBe(false);
    });

    it('refuses to void a captured charge — that is a refund', () => {
      expect(fsm.can('captured', 'void')).toBe(false);
    });

    it('refuses to authorize a failed charge — a retry is a new charge', () => {
      expect(fsm.can('failed', 'authorize')).toBe(false);
    });

    it('refuses to settle an already-settled charge', () => {
      // The idempotency of a redelivered `settlement.completed` is the consumer's job,
      // but the FSM must not quietly allow a second settle either.
      expect(fsm.can('settled', 'settle')).toBe(false);
    });
  });

  describe('terminal states', () => {
    it('marks failed, voided, expired and reversed terminal', () => {
      expect([...fsm.terminalStates].sort()).toEqual(['expired', 'failed', 'reversed', 'voided']);
    });

    it('does not mark settled terminal — a chargeback still reverses it', () => {
      expect(fsm.terminalStates.has('settled')).toBe(false);
      expect(() => fsm.assertNotTerminal('settled')).not.toThrow();
    });

    it('assertNotTerminal throws on voided', () => {
      expect(() => fsm.assertNotTerminal('voided')).toThrow(InvalidStateTransitionException);
    });
  });
});
