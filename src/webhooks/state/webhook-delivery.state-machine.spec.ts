import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { WebhookDeliveryStateMachine } from 'src/webhooks/state/webhook-delivery.state-machine';

// yael: WebhookDeliveryJob drives this every 15s. The `delivering → pending` edge is the
// one that matters — without it a delivery that times out is stuck forever.
describe('WebhookDeliveryStateMachine', () => {
  let fsm: WebhookDeliveryStateMachine;

  beforeEach(() => {
    fsm = new WebhookDeliveryStateMachine();
  });

  it('pending → delivering when the job picks it up', () => {
    expect(fsm.apply('pending', 'attempt')).toBe('delivering');
  });

  it('delivering → delivered on a 2xx', () => {
    expect(fsm.apply('delivering', 'succeed')).toBe('delivered');
  });

  it('delivering → pending on a retryable failure', () => {
    expect(fsm.apply('delivering', 'retry')).toBe('pending');
  });

  it('delivering → dead once the attempts are exhausted', () => {
    expect(fsm.apply('delivering', 'exhaust')).toBe('dead');
  });

  it('dead → pending on an operator redelivery', () => {
    // POST /v1/webhook_events/:eventId/redeliver. Without this edge the route is a 409.
    expect(fsm.apply('dead', 'redeliver')).toBe('pending');
  });

  it('delivered → pending on an operator redelivery', () => {
    expect(fsm.apply('delivered', 'redeliver')).toBe('pending');
  });

  it('cannot exhaust a pending event that has not been attempted', () => {
    expect(fsm.can('pending', 'exhaust')).toBe(false);
    expect(() => fsm.apply('pending', 'exhaust')).toThrow(InvalidStateTransitionException);
  });

  it('cannot succeed without attempting first', () => {
    expect(fsm.can('pending', 'succeed')).toBe(false);
  });

  it('has no terminal state — redelivery can always revive an event', () => {
    expect(fsm.terminalStates.size).toBe(0);
    expect(() => fsm.assertNotTerminal('dead')).not.toThrow();
  });
});
