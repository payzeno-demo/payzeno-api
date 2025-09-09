import { Column, Entity, Index, OneToMany } from 'typeorm';
import type { PublicEventType, WebhookEndpointStatus } from '@payzeno/contracts';
import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { WebhookEventEntity } from './webhook-event.entity';

/**
 * `webhook_endpoint` — data-model.md §1.9.
 *
 * The signing secret is ENVELOPE-ENCRYPTED, not hashed. You cannot compute an HMAC from a
 * hash of the key, so a `signing_secret_hash` column makes the whole outbound signature
 * scheme unimplementable. Migration 24 fixed that; the hash column was dropped a release
 * later, and `WebhookSecretService` still carries the read-side fallback.
 */
@Entity({ name: 'webhook_endpoint' })
@Index('ix_webhook_endpoint_merchant_id', ['merchantId'])
export class WebhookEndpointEntity extends MerchantScopedEntity {
  @Column({ name: 'url', type: 'text' })
  url!: string;

  /**
   * Constrained to `PUBLIC_EVENT_TYPES`, not free-form strings — the console renders a
   * checklist off it and `WebhookFanoutConsumer` matches on it.
   */
  @Column({ name: 'enabled_events', type: 'text', array: true })
  enabledEvents!: PublicEventType[];

  @Column({ name: 'signing_secret_encrypted', type: 'bytea' })
  signingSecretEncrypted!: Buffer;

  @Column({ name: 'last_success_at', type: 'timestamptz', nullable: true })
  lastSuccessAt!: Date | null;

}
