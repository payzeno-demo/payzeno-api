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

  @Column({ name: 'type', type: 'text' })
  type!: PublicEventType;

  @Column({ name: 'signature_version', type: 'varchar', length: 4, default: 'v1' })
  signatureVersion!: 'v1';

  /** 12 attempts or 72h since creation, whichever comes first. */
  isExhausted(now: Date): boolean {
    return (
      this.attemptCount >= WEBHOOK_TERMINAL_ATTEMPTS ||
      now.getTime() - this.createdAt.getTime() >= WEBHOOK_RETRY_WINDOW_MS
    );
  }

}
