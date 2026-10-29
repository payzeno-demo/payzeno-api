import { AdminOperationsService } from 'src/admin/admin-operations.service';
import type { DisputeRepository } from 'src/disputes/dispute.repository';
import type { LedgerHttpClient } from 'src/ledger/ledger-http.client';
import type { SupportTasksService } from 'src/support/support-tasks.service';

import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The platform-wide reads a staff operator needs and a merchant-scoped route cannot give:
 * disputes across every merchant, and the ledger's reconciliation backlog passed through.
 */
describe('AdminOperationsService', () => {
  const NOW = new Date('2026-05-02T11:30:00.000Z');

  let qb: { andWhere: jest.Mock; orderBy: jest.Mock; addOrderBy: jest.Mock; take: jest.Mock; getMany: jest.Mock };
  let ledger: { request: jest.Mock };
  let supportTasks: { listForStaff: jest.Mock; resolveForStaff: jest.Mock };
  let service: AdminOperationsService;

  beforeEach(() => {
    qb = {
      andWhere: jest.fn(() => qb),
      orderBy: jest.fn(() => qb),
      addOrderBy: jest.fn(() => qb),
      take: jest.fn(() => qb),
      getMany: jest.fn(async () => [
        {
          id: 'dp_1',
          merchantId: TEST_MERCHANT_ID,
          charge_id: 'ch_1',
          amount_minor: 5000,
          fee_minor: 1500,
          currency: 'USD',
          status: 'needs_response',
          reason: 'fraudulent',
          network_reason_code: '10.4',
          evidence_due_by: NOW,
          evidence: {},
          is_charge_refundable: true,
          liability_shifted: false,
          submitted_at: null,
          resolved_at: null,
          createdAt: NOW,
        },
      ]),
    };
    ledger = { request: jest.fn(async () => ({ object: 'reconciliation_backlog', retryable: 3 })) };
    supportTasks = { listForStaff: jest.fn(), resolveForStaff: jest.fn() };

    service = new AdminOperationsService(
      { createQueryBuilder: () => qb } as unknown as DisputeRepository,
      ledger as unknown as LedgerHttpClient,
      supportTasks as unknown as SupportTasksService,
    );
  });

  it('lists disputes across merchants, newest first, as the public Dispute shape', async () => {
    const page = await service.listDisputes({ status: 'needs_response', merchantId: TEST_MERCHANT_ID }, { limit: 10 });

    expect(qb.andWhere).toHaveBeenCalledWith('dispute.status = :status', { status: 'needs_response' });
    expect(qb.andWhere).toHaveBeenCalledWith('dispute.merchant_id = :merchantId', { merchantId: TEST_MERCHANT_ID });
    expect(qb.orderBy).toHaveBeenCalledWith('dispute.created_at', 'DESC');
    expect(page.data[0]).toMatchObject({ id: 'dp_1', object: 'dispute', merchant_id: TEST_MERCHANT_ID });
  });

  it('passes the ledger backlog through, filters included', async () => {
    const backlog = await service.settlementBacklog({ currency: 'EUR' });

    expect(ledger.request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/internal/v1/reconciliation/backlog',
      query: { currency: 'EUR', batch_id: undefined },
    });
    expect(backlog).toMatchObject({ object: 'reconciliation_backlog', retryable: 3 });
  });
});
