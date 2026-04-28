import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import type { PublicEventType, WebhookEventStatus } from '@payzeno/contracts';
import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { WebhookEndpointEntity } from './webhook-endpoint.entity';

/** domain-model.md §10: 12 attempts or 72 hours, whichever comes first. */
export const WEBHOOK_TERMINAL_ATTEMPTS = 12;
export const WEBHOOK_RETRY_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * `webhook_event` — data-model.md §1.9. Payzeno's OUTBOUND notification to the merchant's
 * own server. Not to be confused with the internal bus events in @payzeno/contracts/events,
 * nor with the acquirer's inbound webhooks (those land in ProcessorWebhookController).
 *
 * Written by exactly one thing: `WebhookFanoutConsumer`, ON CONFLICT DO NOTHING against
 * `uq_webhook_event_source`. `WebhookDeliveryJob` only ever updates delivery state.
 */
@Entity({ name: 'webhook_event' })
@Index('uq_webhook_event_source', ['endpointId', 'sourceEventId'], { unique: true })
@Index('pix_webhook_event_due', ['nextAttemptAt'], { where: "status = 'pending'" })
@Index('ix_webhook_event_merchant_created', ['merchantId', 'createdAt'])
@Index('ix_webhook_event_type', ['type'])
export class WebhookEventEntity extends MerchantScopedEntity {
  @Column({ name: 'endpoint_id', type: 'text' })
  endpointId!: string;

  @JoinColumn({ name: 'endpoint_id' })
  endpoint!: WebhookEndpointEntity;

  @Column({ name: 'type', type: 'text' })
  type!: PublicEventType;

  /** The bus `EventEnvelope.id` this was fanned out from. The at-least-once dedupe key. */
  @Column({ name: 'source_event_id', type: 'text' })
  sourceEventId!: string;

  @Column({ name: 'status', type: 'text', default: 'pending' })
  status!: WebhookEventStatus;

  @Column({ name: 'attempt_count', type: 'smallint', default: 0 })
  attemptCount!: number;

  @Column({ name: 'signature_version', type: 'varchar', length: 4, default: 'v1' })
  signatureVersion!: 'v1';

  computeNextAttempt(from: Date): Date {
    const base = 60 * 1000 * Math.pow(2, Math.min(this.attemptCount, WEBHOOK_TERMINAL_ATTEMPTS));
    const jitter = 1 + (Math.random() * 0.4 - 0.2);
    return new Date(from.getTime() + Math.round(base * jitter));
  }

  /** 12 attempts or 72h since creation, whichever comes first. */
  isExhausted(now: Date): boolean {
    return (
      this.attemptCount >= WEBHOOK_TERMINAL_ATTEMPTS ||
      now.getTime() - this.createdAt.getTime() >= WEBHOOK_RETRY_WINDOW_MS
    );
  }

  /** The exact bytes signed and sent. Kept stable so a re-delivery has the same signature. */
  serialize(): string {
    return JSON.stringify({
      id: this.id,
      object: 'event',
      type: this.type,
      livemode: this.livemode,
      created: Math.floor(this.createdAt.getTime() / 1000),
      data: { object: this.payload },
    });
  }
}
