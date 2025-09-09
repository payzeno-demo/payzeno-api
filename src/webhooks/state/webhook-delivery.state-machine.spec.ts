import { InvalidStateTransitionException } from 'src/common/errors/state.exceptions';
import { WebhookDeliveryStateMachine } from 'src/webhooks/state/webhook-delivery.state-machine';

// yael: WebhookDeliveryJob drives this every 15s. The `delivering → pending` edge is the
// one that matters — without it a delivery that times out is stuck forever.
describe('WebhookDeliveryStateMachine', () => {
  let fsm: WebhookDeliveryStateMachine;

  it('delivering → pending on a retryable failure', () => {
    expect(fsm.apply('delivering', 'retry')).toBe('pending');
  });

  it('cannot succeed without attempting first', () => {
    expect(fsm.can('pending', 'succeed')).toBe(false);
  });

});
