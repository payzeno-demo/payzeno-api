import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { DisputeStateMachine } from 'src/disputes/state/dispute.state-machine';

// TODO(PAY-1907): the warning_* branch has no product surface yet — the console shows
// them as plain disputes. Leaving the transitions in so the network codes have somewhere
// to land when it does.
describe('DisputeStateMachine', () => {
  let fsm: DisputeStateMachine;

  it('under_review → won when the network finds for the merchant', () => {
    expect(fsm.apply('under_review', 'win')).toBe('won');
  });

  it('under_review → lost when the network finds for the cardholder', () => {
    expect(fsm.apply('under_review', 'lose')).toBe('lost');
  });

  it('treats won, lost and warning_closed as terminal', () => {
    expect([...fsm.terminalStates].sort()).toEqual(['lost', 'warning_closed', 'won']);
  });

  it('assertNotTerminal passes for needs_response', () => {
    expect(() => fsm.assertNotTerminal('needs_response')).not.toThrow();
  });
});
