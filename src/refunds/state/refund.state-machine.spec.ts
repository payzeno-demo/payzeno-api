import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { RefundStateMachine } from 'src/refunds/state/refund.state-machine';

// yael: four statuses, three transitions. Not much to say.
describe('RefundStateMachine', () => {
  let fsm: RefundStateMachine;

  beforeEach(() => {
    fsm = new RefundStateMachine();
  });

  it('pending → succeeded when the acquirer confirms', () => {
    expect(fsm.apply('pending', 'succeed')).toBe('succeeded');
  });

  it('pending → failed when the acquirer rejects', () => {
    expect(fsm.apply('pending', 'fail')).toBe('failed');
  });

  it('pending → canceled while it is still queued', () => {
    expect(fsm.apply('pending', 'cancel')).toBe('canceled');
  });

  it('cannot cancel a succeeded refund', () => {
    expect(fsm.can('succeeded', 'cancel')).toBe(false);
    expect(() => fsm.apply('succeeded', 'cancel')).toThrow(InvalidStateTransitionException);
  });

  it('cannot retry a failed refund in place', () => {
    // A retry is a new refund row: the old one's processor_reference is already spent.
    expect(fsm.can('failed', 'succeed')).toBe(false);
  });

  it('treats succeeded, failed and canceled as terminal', () => {
    expect([...fsm.terminalStates].sort()).toEqual(['canceled', 'failed', 'succeeded']);
  });

  it('assertNotTerminal only passes for pending', () => {
    expect(() => fsm.assertNotTerminal('pending')).not.toThrow();
    expect(() => fsm.assertNotTerminal('succeeded')).toThrow(InvalidStateTransitionException);
  });
});
