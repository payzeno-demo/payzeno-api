/**
 * EmailService — RFC platform-v2 §2. The one way anything in payzeno-api sends an email.
 *
 * `queue()` records the message in `email_outbox` inside the caller's transaction, so an email
 * is sent if and only if the business change that caused it commits. Pass the EntityManager
 * when you hold one; without it the row joins whatever transaction `TransactionManager` has in
 * flight (the same trick `OutboxEventPublisher` uses), and only outside any transaction does it
 * stand alone. `EmailDeliveryJob` renders and sends over SMTP with retries.
 *
 * The subject is rendered here, at queue time, so `GET /v1/admin/emails` can show what a queued
 * or failed message says; the bodies are rendered at send time and never stored.
 *
 * Addresses are PII: logs carry the message id and the recipient's DOMAIN, never the address.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { EmailMessage, EmailTemplate, MerchantId, Paginated } from '@payzeno/contracts';

import { IdFactory } from '../../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { resolveListQuery } from '../../common/pagination/list-query.dto';
import { TransactionManager } from '../../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../../common/time/clock';
import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';

import { EmailOutboxEntity } from './email-outbox.entity';
import { EmailOutboxRepository, type EmailLookupFilter } from './email-outbox.repository';
import { renderSubject } from './templates/email-templates';

export interface QueueEmailInput {
  template: EmailTemplate;
  to: string;
  /** Template variables. Plain JSON; never card data, never a password. */
  data: Record<string, string | number | boolean | null>;
  merchantId?: MerchantId | null;
  livemode?: boolean;
}

/** `msg_` — EmailMessage in the contracts prefix table. */
const EMAIL_MESSAGE_PREFIX = 'msg_';

@Injectable()
export class EmailService {
  constructor(
    private readonly outbox: EmailOutboxRepository,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async queue(input: QueueEmailInput, manager?: EntityManager): Promise<void> {
    const to = input.to.trim().toLowerCase();
    const now = this.clock.now();

    const row = new EmailOutboxEntity();
    row.id = this.ids.opaque(EMAIL_MESSAGE_PREFIX);
    row.template = input.template;
    row.toAddress = to;
    row.subject = renderSubject(input.template, input.data, { consoleUrl: this.config.publicUrls.console });
    row.data = { ...input.data };
    row.merchantId = input.merchantId ?? null;
    row.livemode = input.livemode ?? true;
    row.status = 'queued';
    row.attemptCount = 0;
    row.nextAttemptAt = now;
    row.lastError = null;
    row.providerMessageId = null;
    row.sentAt = null;
    row.createdAt = now;
    row.updatedAt = now;

    await this.outbox.append(row, manager ?? this.transactions.currentManager());

    this.logger.info('email.queued', {
      email_id: row.id,
      template: row.template,
      to_domain: domainOf(to),
      merchant_id: row.merchantId,
    });
  }

  /** Support's "did we email them?" — `GET /v1/admin/emails`. Metadata only, never a body. */
  async lookup(
    filter: EmailLookupFilter,
    query: { limit?: number; cursor?: string },
  ): Promise<Paginated<EmailMessage>> {
    const page = await this.outbox.lookup(
      { ...filter, to: filter.to?.trim().toLowerCase() },
      resolveListQuery(query),
    );
    return { data: page.data.map((row) => row.toEmailMessage()), has_more: page.has_more, next_cursor: page.next_cursor };
  }
}

export function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? 'unknown' : address.slice(at + 1);
}
