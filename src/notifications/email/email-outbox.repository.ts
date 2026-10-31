/**
 * L1. The only code that writes `email_outbox`.
 *
 * `claimDue` is the part worth reading. It selects due rows `FOR UPDATE SKIP LOCKED` and pushes
 * their `next_attempt_at` forward to a lease in the same short transaction, so the SMTP round
 * trips happen OUTSIDE any transaction and a second task (or this one, next tick) cannot pick
 * the same message up while it is being sent. If the process dies mid-send the lease expires and
 * the row is retried — at-least-once, which for email is the right side to err on.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, In, type EntityManager } from 'typeorm';

import type { EmailTemplate, MerchantId, Paginated } from '@payzeno/contracts';

import type { ResolvedListQuery } from '../../common/pagination/list-query.dto';
import { applyCursor, toPage } from '../../common/persistence/cursor';
import { PayzenoRepository, toInsertRow } from '../../common/persistence/payzeno.repository';

import { EmailOutboxEntity } from './email-outbox.entity';

export interface EmailLookupFilter {
  to?: string;
  merchantId?: MerchantId;
  template?: EmailTemplate;
}

@Injectable()
export class EmailOutboxRepository extends PayzenoRepository<EmailOutboxEntity> {
  constructor(dataSource: DataSource) {
    super(EmailOutboxEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'email_outbox';
  }

  async append(row: EmailOutboxEntity, manager: EntityManager): Promise<void> {
    await this.insertMapped(toInsertRow(row), manager);
  }

  /** Due rows, leased until `leaseUntil`. Oldest first, so a backlog drains in order. */
  async claimDue(limit: number, now: Date, leaseUntil: Date): Promise<EmailOutboxEntity[]> {
    return this.manager.transaction(async (tx) => {
      const rows = await tx
        .getRepository(EmailOutboxEntity)
        .createQueryBuilder('email_outbox')
        .where("email_outbox.status = 'queued'")
        .andWhere('email_outbox.next_attempt_at <= :now', { now })
        .orderBy('email_outbox.next_attempt_at', 'ASC')
        .limit(limit)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      if (rows.length > 0) {
        await tx.update(
          EmailOutboxEntity,
          { id: In(rows.map((row) => row.id)) },
          { nextAttemptAt: leaseUntil },
        );
      }
      return rows;
    });
  }

  async markSent(id: string, attemptCount: number, sentAt: Date, providerMessageId: string | null): Promise<void> {
    await this.update(
      { id },
      { status: 'sent', attemptCount, sentAt, providerMessageId, lastError: null },
    );
  }

  async markRetry(id: string, attemptCount: number, nextAttemptAt: Date, error: string): Promise<void> {
    await this.update({ id }, { attemptCount, nextAttemptAt, lastError: error });
  }

  async markFailed(id: string, attemptCount: number, error: string): Promise<void> {
    await this.update({ id }, { status: 'failed', attemptCount, lastError: error });
  }

  /** `GET /v1/admin/emails`. Platform-wide, so not `paginateCursor` (which is tenant-scoped). */
  async lookup(filter: EmailLookupFilter, query: ResolvedListQuery): Promise<Paginated<EmailOutboxEntity>> {
    const qb = this.createQueryBuilder('email_outbox');

    if (filter.to) qb.andWhere('email_outbox.to_address = :to', { to: filter.to.trim() });
    if (filter.merchantId) qb.andWhere('email_outbox.merchant_id = :merchantId', { merchantId: filter.merchantId });
    if (filter.template) qb.andWhere('email_outbox.template = :template', { template: filter.template });

    const rows = await applyCursor(qb, { limit: query.limit, cursor: query.cursor, alias: 'email_outbox' }).getMany();
    return toPage(rows, query.limit);
  }
}
