/**
 * AdminOperationsService — the back office's platform-wide queues (RFC platform-v2 §1):
 * disputes across every merchant, the ledger's reconciliation backlog, and support tasks.
 *
 * Each of these already has an owner that acts on it (`POST /v1/disputes/:id/accept`,
 * `POST /v1/settlements/:b/items/:i/retry`, `SupportTasksService`); this is the read side the
 * merchant-scoped routes cannot give a staff operator, who has no single merchant to scope to.
 */
import { Injectable } from '@nestjs/common';

import type {
  CurrencyCode,
  Dispute,
  DisputeStatus,
  ListQuery,
  MerchantId,
  Paginated,
  ReconciliationBacklog,
  SupportTask,
} from '@payzeno/contracts';

import { resolveListQuery } from '../common/pagination/list-query.dto';
import { applyCursor, toPage } from '../common/persistence/cursor';
import { DisputeRepository } from '../disputes/dispute.repository';
import { toDispute } from '../disputes/disputes.service';
import { LedgerHttpClient } from '../ledger/ledger-http.client';
import { SupportTasksService, type SupportTaskSearch } from '../support/support-tasks.service';

export interface AdminDisputeSearch {
  status?: DisputeStatus;
  merchantId?: MerchantId;
}

@Injectable()
export class AdminOperationsService {
  constructor(
    private readonly disputes: DisputeRepository,
    private readonly ledger: LedgerHttpClient,
    private readonly supportTasks: SupportTasksService,
  ) {}

  /** `GET /v1/admin/disputes`. Every merchant, both modes, newest first. */
  async listDisputes(filter: AdminDisputeSearch, query: ListQuery): Promise<Paginated<Dispute>> {
    const resolved = resolveListQuery(query);
    const qb = this.disputes.createQueryBuilder('dispute');

    if (filter.status) qb.andWhere('dispute.status = :status', { status: filter.status });
    if (filter.merchantId) qb.andWhere('dispute.merchant_id = :merchantId', { merchantId: filter.merchantId });

    const page = toPage(
      await applyCursor(qb, { limit: resolved.limit, cursor: resolved.cursor, alias: 'dispute' }).getMany(),
      resolved.limit,
    );
    return { data: page.data.map(toDispute), has_more: page.has_more, next_cursor: page.next_cursor };
  }

  /**
   * `GET /v1/admin/settlements/backlog` — the ledger's `GET /internal/v1/reconciliation/backlog`,
   * passed through. Acquirer-level numbers, which is exactly why only staff may see them.
   */
  settlementBacklog(query: { currency?: CurrencyCode; batch_id?: string }): Promise<ReconciliationBacklog> {
    return this.ledger.request<ReconciliationBacklog>({
      method: 'GET',
      path: '/internal/v1/reconciliation/backlog',
      query: { currency: query.currency, batch_id: query.batch_id },
    });
  }

  /** `GET /v1/admin/support-tasks`. */
  listSupportTasks(filter: SupportTaskSearch, query: ListQuery): Promise<Paginated<SupportTask>> {
    return this.supportTasks.listForStaff(filter, resolveListQuery(query));
  }

  /** `POST /v1/admin/support-tasks/:taskId/resolve`. */
  resolveSupportTask(taskId: string, note: string | null, staffId: string): Promise<SupportTask> {
    return this.supportTasks.resolveForStaff(taskId, note, staffId);
  }
}
