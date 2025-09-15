/**
 * The publish port. Two implementations, deliberately:
 *
 *   OutboxEventPublisher — writes `event_outbox` inside the caller's transaction. This is
 *                          the production path for anything that must not be lost, and it
 *                          is the only publisher a business service is allowed to inject.
 *   SnsEventPublisher    — talks to SNS. Reached only by `OutboxDrainJob`.
 *
 * ADR 0011 (docs/adr/0011-outbox-over-direct-publish.md) is the argument. Short version:
 * a direct publish that succeeds after the transaction rolls back tells the ledger about a
 * charge that does not exist, and a direct publish that fails after it commits loses the
 * only propagation path we have.
 */
import { EVENT_TOPICS } from '@payzeno/contracts/events';
import type {
  EventType,
  PayloadOfType,
  PayzenoEvent,
} from '@payzeno/contracts/events';

import type { PublishContext, TopicName } from './publisher.types';

export interface EventPublisher {
  /** Returns the `evt_` id stamped on the envelope. */
  publish<T extends EventType>(
    type: T,
    payload: PayloadOfType<T>,
    ctx: PublishContext,
  ): Promise<string>;

  publishBatch(events: ReadonlyArray<PayzenoEvent>): Promise<string[]>;
}

/**
 * Nest injection token. `EventPublisher` is an interface and therefore has no runtime
 * value, so every consumer takes `@Inject(EVENT_PUBLISHER)`. `EventsModule` binds it to
 * `OutboxEventPublisher`.
 */
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');

