import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * `processed_event` — data-model.md §1.12.
 *
 * PK is `(event_id, consumer)`, widened by migration 26 during the INC hardening.
 * payzeno-api has two consumers whose handled sets overlap — `LedgerEventsConsumer` and
 * `DeadLetterConsumer` (handled types: all) — so with `event_id` alone a redriven event
 * already processed by the first collides on insert and the DLQ consumer can never mark
 * anything processed.
 *
 * Rows are claimed INSERT-FIRST inside the handler's transaction
 * (`BaseEventConsumer.claimEvent`). Never check-then-act: that is the shape of PAY-2041 and
 * ADR 0011 forbids it in the money path.
 */
@Entity({ name: 'processed_event' })
export class ProcessedEvent {
  /** The bus `EventEnvelope.id`. */
  @PrimaryColumn({ name: 'event_id', type: 'text' })
  eventId!: string;

  /** `BaseEventConsumer.consumerName` — stable across deploys, never the class instance. */
  @PrimaryColumn({ name: 'consumer', type: 'text' })
  consumer!: string;

  @Column({ name: 'processed_at', type: 'timestamptz', default: () => 'now()' })
  processedAt!: Date;
}

