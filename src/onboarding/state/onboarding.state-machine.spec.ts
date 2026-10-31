import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { OnboardingStateMachine } from 'src/onboarding/state/onboarding.state-machine';

/** RFC platform-v2 §3: collecting → submitted → (needs_info → submitted)* → approved | rejected. */
describe('OnboardingStateMachine', () => {
  const fsm = new OnboardingStateMachine();

  it.each([
    ['collecting', 'submit', 'submitted'],
    ['submitted', 'approve', 'approved'],
    ['submitted', 'reject', 'rejected'],
    ['submitted', 'request_info', 'needs_info'],
    ['needs_info', 'submit', 'submitted'],
    ['needs_info', 'reject', 'rejected'],
  ] as const)('%s --%s--> %s', (from, event, to) => {
    expect(fsm.apply(from, event)).toBe(to);
  });

  it.each([
    ['collecting', 'approve'],
    ['needs_info', 'approve'],
    ['approved', 'reject'],
    ['rejected', 'submit'],
    ['submitted', 'submit'],
  ] as const)('refuses %s --%s-->', (from, event) => {
    expect(() => fsm.apply(from, event)).toThrow(InvalidStateTransitionException);
  });

  it('treats approved and rejected as terminal', () => {
    expect([...fsm.terminalStates].sort()).toEqual(['approved', 'rejected']);
  });

  it('lets the merchant edit only in the states it owns', () => {
    expect(fsm.isEditable('collecting')).toBe(true);
    expect(fsm.isEditable('needs_info')).toBe(true);
    expect(fsm.isEditable('submitted')).toBe(false);
    expect(() => fsm.assertEditable('submitted')).toThrow(InvalidStateTransitionException);
    expect(() => fsm.assertEditable('approved')).toThrow(InvalidStateTransitionException);
  });
});
