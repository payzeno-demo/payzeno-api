/**
 * `email_outbox` — RFC platform-v2 §2, migration 1731000000000.
 *
 * One row per message, written by `EmailService.queue` inside the business transaction and
 * moved to `sent` or `failed` by `EmailDeliveryJob`. Not merchant-scoped in the
 * `MerchantScopedEntity` sense: a password reset belongs to a person, not to a mode, and a
 * shopper receipt is addressed to someone who is not a Payzeno user at all.
 *
 * `data` is the template's variables as queued. It can carry a single-use link (verify, invite,
 * reset), which is why `toEmailMessage()` — the only wire shape — has neither `data` nor a body.
 */
import { Column, Entity, Index } from 'typeorm';

import type { EmailMessage, EmailStatus, EmailTemplate, MerchantId } from '@payzeno/contracts';

import { BaseEntity } from '../../common/base/base.entity';

import type { EmailTemplateData } from './templates/email-templates';

@Entity({ name: 'email_outbox' })
@Index('pix_email_outbox_due', ['nextAttemptAt'], { where: "status = 'queued'" })
@Index('ix_email_outbox_to_created', ['toAddress', 'createdAt'])
@Index('ix_email_outbox_merchant_created', ['merchantId', 'createdAt'])
export class EmailOutboxEntity extends BaseEntity {
  @Column({ name: 'template', type: 'text' })
  template!: EmailTemplate;

  /** citext: the admin lookup is case-insensitive without a lower(). */
  @Column({ name: 'to_address', type: 'citext' })
  toAddress!: string;

  @Column({ name: 'subject', type: 'text' })
  subject!: string;

  @Column({ name: 'data', type: 'jsonb', default: () => "'{}'::jsonb" })
  data!: EmailTemplateData;

  @Column({ name: 'merchant_id', type: 'text', nullable: true })
  merchantId!: MerchantId | null;

  @Column({ name: 'livemode', type: 'boolean', default: true })
  livemode!: boolean;

  @Column({ name: 'status', type: 'text', default: 'queued' })
  status!: EmailStatus;

  @Column({ name: 'attempt_count', type: 'integer', default: 0 })
  attemptCount!: number;

  /** Claimed by the delivery job when `<= now`; pushed forward as a lease while it sends. */
  @Column({ name: 'next_attempt_at', type: 'timestamptz' })
  nextAttemptAt!: Date;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;

  /** The SMTP server's queue id / Message-ID, for correlating with the relay's own logs. */
  @Column({ name: 'provider_message_id', type: 'text', nullable: true })
  providerMessageId!: string | null;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  toEmailMessage(): EmailMessage {
    return {
      id: this.id,
      object: 'email_message',
      template: this.template,
      to: this.toAddress,
      subject: this.subject,
      status: this.status,
      merchant_id: this.merchantId,
      created_at: this.toIsoCreatedAt(),
      sent_at: this.sentAt ? this.sentAt.toISOString() : null,
    };
  }
}
