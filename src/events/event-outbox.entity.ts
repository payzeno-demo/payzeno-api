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

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;

}
