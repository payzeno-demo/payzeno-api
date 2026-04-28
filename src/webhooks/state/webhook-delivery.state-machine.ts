import { Injectable } from '@nestjs/common';
import type { WebhookEventStatus } from '@payzeno/contracts';
import { StateMachine } from '../../payments/state/state-machine';

/** The events that move a `webhook_event` between statuses. */
export type WebhookDeliveryEvent = 'dispatch' | 'succeed' | 'retry' | 'exhaust';

/**
 * domain-model.md §10:
 *
 *   pending ──▶ delivering ──▶ delivered   (terminal, 2xx)
 *                    │
 *                    ├──▶ pending          (retry, exponential backoff 1m·2^n, jitter ±20%)
 *                    └──▶ dead             (terminal, attempt_count == 12 or 72h elapsed)
 *
 * Pure. No I/O — `WebhookDeliveryJob` owns the timing and the persistence; this owns only
 * the question "is that transition legal", and throws `InvalidStateTransitionException`
 * through `StateMachine.apply` when it is not.
 */
@Injectable()
export class WebhookDeliveryStateMachine extends StateMachine<
  WebhookEventStatus,
  WebhookDeliveryEvent
> {
  protected readonly transitions: Readonly<
    Record<WebhookEventStatus, Partial<Record<WebhookDeliveryEvent, WebhookEventStatus>>>
  > = {
    pending: { dispatch: 'delivering' },
    delivering: { succeed: 'delivered', retry: 'pending', exhaust: 'dead' },
    delivered: {},
    dead: {},
  };

  readonly entityName = 'webhook_event';

  /**
   * The one piece of policy that is genuinely a state question rather than a timing one:
   * a delivery attempt that came back non-2xx either retries or dies, and which one it is
   * depends on the budget, not on the response.
   */
  outcomeFor(exhausted: boolean): WebhookDeliveryEvent {
    return exhausted ? 'exhaust' : 'retry';
  }

  /** True when the row is in a state a delivery attempt may start from. */
  canDispatch(status: WebhookEventStatus): boolean {
    return this.can(status, 'dispatch');
  }
}
