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

}
