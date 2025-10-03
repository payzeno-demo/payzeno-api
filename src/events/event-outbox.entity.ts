import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { EventType } from '@payzeno/contracts/events';
import type { MerchantId } from '@payzeno/contracts';

/**
 * `event_outbox` — data-model.md §1.11.
 *
 * Deliberately NOT extending `BaseEntity`: the pk is the `evt_` id minted by the publisher
 * (so the envelope id survives the drain) and there is no `updated_at` — a row is written
 * once by the business transaction and then only ever stamped by the drain.
 */
@Entity({ name: 'event_outbox' })
@Index('pix_event_outbox_due', ['nextAttemptAt'], {
  where: 'published_at is null and dead_at is null',
})
export class EventOutbox {
  /** `evt_` + ULID. Becomes `EventEnvelope.id`, which is every consumer's dedupe key. */
  @PrimaryColumn({ name: 'id', type: 'text' })
  id!: string;

  /** Stamped from `EVENT_SCHEMA_VERSIONS` at publish time, never re-derived on drain. */
  @Column({ name: 'version', type: 'smallint' })
  version!: number;

  @Column({ name: 'merchant_id', type: 'text', nullable: true })
  merchantId!: MerchantId | null;

  @Column({ name: 'correlation_id', type: 'text' })
  correlationId!: string;

  @Column({ name: 'causation_id', type: 'text', nullable: true })
  causationId!: string | null;

  /** When the fact became true in payzeno-api, not when the drain got to it. */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ name: 'attempt_count', type: 'smallint', default: 0 })
  attemptCount!: number;

  /**
   * 2^attempt seconds with ±20% jitter. Without it a permanently failing event is
   * re-selected every 5 seconds forever.
   */
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

}
