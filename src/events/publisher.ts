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

/** Bound to `SnsEventPublisher`. Only `OutboxDrainJob` asks for this one. */
export const BUS_PUBLISHER = Symbol('BUS_PUBLISHER');

/**
 * Which SNS topic an event type belongs on.
 *
 * This is `EVENT_TOPICS` from @payzeno/contracts/events, inverted once at module load so a
 * publisher can look it up by type in O(1). It used to be a hand-maintained copy of the same
 * twenty-eight rows, and the copy is exactly the thing `topics.ts` warns about: those strings
 * have to match payzeno-infrastructure's `sns.tf` and nothing checks it across repos, so a
 * second transcription is a second place to get it wrong.
 *
 * payzeno-api only publishes on two of the four topics; the ledger and billing entries matter
 * because `DeadLetterConsumer` redrives events it did not originate and must route them back.
 */
const TOPIC_OF_TYPE: ReadonlyMap<EventType, TopicName> = new Map(
  (Object.keys(EVENT_TOPICS) as TopicName[]).flatMap((topic): Array<[EventType, TopicName]> => {
    const types: readonly EventType[] = EVENT_TOPICS[topic];
    return types.map((type) => [type, topic]);
  }),
);

export function topicOf(type: EventType): TopicName {
  const topic = TOPIC_OF_TYPE.get(type);
  if (!topic) {
    throw new Error(`no SNS topic is declared for event type "${type}"`);
  }
  return topic;
}

/**
 * True for the events payzeno-api is allowed to originate. `OutboxEventPublisher` asserts
 * this: a service that tries to publish `settlement.completed` has misunderstood who owns
 * settlement, and the ledger will happily consume its own event back off the topic.
 */
export function isApiOwnedEvent(type: EventType): boolean {
  const topic = topicOf(type);
  return topic === 'payzeno-payments-events' || topic === 'payzeno-merchant-events';
}
