import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { DisputeStateMachine } from 'src/disputes/state/dispute.state-machine';

// TODO(PAY-1907): the warning_* branch has no product surface yet — the console shows
// them as plain disputes. Leaving the transitions in so the network codes have somewhere
// to land when it does.
describe('DisputeStateMachine', () => {
  let fsm: DisputeStateMachine;

  beforeEach(() => {
    fsm = new DisputeStateMachine();
  });

  it('needs_response → under_review when evidence is submitted', () => {
    expect(fsm.apply('needs_response', 'submit_evidence')).toBe('under_review');
  });

  it('needs_response → lost when the merchant accepts liability', () => {
    expect(fsm.apply('needs_response', 'accept')).toBe('lost');
  });

  it('needs_response → lost when the evidence deadline passes', () => {
    // DisputeDeadlineReminderJob drives this one, nightly at 07:00.
    expect(fsm.apply('needs_response', 'expire')).toBe('lost');
  });

  it('under_review → won when the network finds for the merchant', () => {
    expect(fsm.apply('under_review', 'win')).toBe('won');
  });

  it('under_review → lost when the network finds for the cardholder', () => {
    expect(fsm.apply('under_review', 'lose')).toBe('lost');
  });

  it('warning_needs_response → warning_closed', () => {
    expect(fsm.apply('warning_needs_response', 'close')).toBe('warning_closed');
  });

  it('cannot submit evidence twice', () => {
    expect(fsm.can('under_review', 'submit_evidence')).toBe(false);
    expect(() => fsm.apply('under_review', 'submit_evidence')).toThrow(
      InvalidStateTransitionException,
    );
  });

  it('cannot accept a dispute that is already under review with the network', () => {
    expect(fsm.can('under_review', 'accept')).toBe(false);
  });

  it('cannot reopen a won dispute', () => {
    expect(fsm.can('won', 'submit_evidence')).toBe(false);
  });

  it('treats won, lost and warning_closed as terminal', () => {
    expect([...fsm.terminalStates].sort()).toEqual(['lost', 'warning_closed', 'won']);
  });

  it('assertNotTerminal passes for needs_response', () => {
    expect(() => fsm.assertNotTerminal('needs_response')).not.toThrow();
  });
});
