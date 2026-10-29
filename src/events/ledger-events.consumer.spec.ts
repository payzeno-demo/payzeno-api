import type { EntityManager } from 'typeorm';
import type {
  PayzenoEvent,
  SettlementCompletedPayload,
  SettlementDuplicateDetectedPayload,
} from '@payzeno/contracts/events';
import { LedgerEventsConsumer } from './ledger-events.consumer';
import { SettlementCompletion } from './settlement-completion.entity';

/**
 * arc INC regression suite. Two of these assertions exist because PAY-2041 happened:
 * the duplicate branch must open a support task for capture-at-settlement merchants, and
 * a batch must not be marked complete until every chunk has landed.
 */
describe('LedgerEventsConsumer', () => {
  const config = {
    aws: { sqsLedgerQueueUrl: 'http://localstack:4566/000000000000/payzeno-api-ledger' },
  };

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  let charges: { markSettledFromBatch: jest.Mock };
  let merchants: { findInternal: jest.Mock };
  let audit: { record: jest.Mock };
  let supportTasks: { open: jest.Mock };
  let mailer: { queueToAdmins: jest.Mock };
  let bankAccounts: { findOne: jest.Mock; findDefault: jest.Mock };
  let tx: { query: jest.Mock; findOneBy: jest.Mock; update: jest.Mock };
  let consumer: LedgerEventsConsumer;

  function completion(seen: number[], chunkCount: number): SettlementCompletion {
    const row = new SettlementCompletion();
    row.batchId = 'sbt_1';
    row.runId = 'rec_1';
    row.chunkCount = chunkCount;
    row.chunksSeen = seen;
    row.chargesMarked = seen.length * 1000;
    row.completedAt = null;
    return row;
  }

  function completedEvent(
    overrides: Partial<SettlementCompletedPayload> = {},
  ): PayzenoEvent {
    return {
      id: 'evt_c1',
      type: 'settlement.completed',
      version: 2,
      occurred_at: '2026-03-01T02:00:00.000Z',
      source: 'payzeno-ledger',
      correlation_id: 'corr_1',
      causation_id: null,
      merchant_id: null,
      livemode: true,
      payload: {
        batch_id: 'sbt_1',
        run_id: 'rec_1',
        acquirer: 'worldflow',
        currency: 'USD',
        processing_date: '2026-03-01',
        items_total: 2000,
        items_settled: 2000,
        items_failed: 0,
        posted_total_minor: 500000,
        fee_total_minor: 12000,
        net_total_minor: 488000,
        settled_charge_ids: ['ch_1', 'ch_2'],
        chunk_index: 0,
        chunk_count: 2,
        completed_at: '2026-03-01T02:00:00.000Z',
        ...overrides,
      },
    } as PayzenoEvent;
  }

  function duplicateEvent(
    overrides: Partial<SettlementDuplicateDetectedPayload> = {},
  ): PayzenoEvent {
    return {
      id: 'evt_d1',
      type: 'settlement.duplicate_detected',
      version: 1,
      occurred_at: '2026-03-01T02:14:00.000Z',
      source: 'payzeno-ledger',
      correlation_id: 'corr_2',
      causation_id: null,
      merchant_id: 'mer_1',
      livemode: true,
      payload: {
        batch_id: 'sbt_1',
        item_id: 'rci_9',
        charge_id: 'ch_9',
        merchant_id: 'mer_1',
        idempotency_key: 'settle:rci_9',
        existing_transaction_id: 'ltx_7',
        detected_by: 'retry_scheduler',
        amount_minor: 4500,
        currency: 'USD',
        detected_at: '2026-03-01T02:14:00.000Z',
        ...overrides,
      },
    } as PayzenoEvent;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    charges = { markSettledFromBatch: jest.fn(async () => 2) };
    merchants = { findInternal: jest.fn(async () => ({ captureAtSettlement: true })) };
    audit = { record: jest.fn(async () => undefined) };
    supportTasks = { open: jest.fn(async () => 'stk_1') };
    mailer = { queueToAdmins: jest.fn(async () => 1) };
    bankAccounts = {
      findOne: jest.fn(async () => ({ lastFour: '6789' })),
      findDefault: jest.fn(async () => ({ lastFour: '4321' })),
    };
    tx = {
      query: jest.fn(async () => []),
      findOneBy: jest.fn(async () => completion([0], 2)),
      update: jest.fn(async () => ({ affected: 1 })),
    };

    consumer = new LedgerEventsConsumer(
      {} as never,
      {} as never,
      {} as never,
      logger as never,
      config as never,
      {
        get: (token: unknown) => {
          const name = (token as { name?: string }).name;
          if (name === 'ChargesService') return charges;
          if (name === 'MerchantsService') return merchants;
          if (name === 'AuditService') return audit;
          if (name === 'MerchantMailerService') return mailer;
          if (name === 'BankAccountRepository') return bankAccounts;
          return supportTasks;
        },
      } as never,
    );
    consumer.onModuleInit();
  });

  it('subscribes to exactly the api-surface §14 type set', () => {
    expect([...consumer.handledTypes].sort()).toEqual([
      'ledger.imbalance_detected',
      'payout.failed',
      'payout.paid',
      'payout.returned',
      'settlement.completed',
      'settlement.duplicate_detected',
      'settlement.variance_detected',
    ]);
  });

  it('marks the chunk’s charges settled and records the chunk', async () => {
    await consumer.handle(completedEvent(), tx as unknown as EntityManager);

    expect(charges.markSettledFromBatch).toHaveBeenCalledWith(tx, ['ch_1', 'ch_2'], {
      settlementBatchId: 'sbt_1',
      settledAt: '2026-03-01T02:00:00.000Z',
    });
    expect(tx.query).toHaveBeenCalledWith(
      expect.stringContaining('insert into settlement_completion'),
      ['sbt_1', 'rec_1', 2, 0, 2],
    );
  });

  it('does not complete the batch while a chunk is missing (PAY-2052)', async () => {
    await consumer.handle(completedEvent(), tx as unknown as EntityManager);

    expect(tx.update).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'settlement.chunk_recorded',
      expect.objectContaining({ missing: '1' }),
    );
  });

  it('completes the batch once every chunk index has arrived', async () => {
    tx.findOneBy.mockResolvedValueOnce(completion([0, 1], 2));

    await consumer.handle(completedEvent({ chunk_index: 1 }), tx as unknown as EntityManager);

    expect(tx.update).toHaveBeenCalledWith(
      SettlementCompletion,
      { batchId: 'sbt_1', runId: 'rec_1' },
      expect.objectContaining({ completedAt: new Date('2026-03-01T02:00:00.000Z') }),
    );
  });

  it('audits every duplicate and opens a task for capture-at-settlement merchants', async () => {
    await consumer.handle(duplicateEvent(), tx as unknown as EntityManager);

    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'settlement.duplicate_detected', resourceId: 'ch_9' }),
    );
    expect(supportTasks.open).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ kind: 'duplicate_settlement', severity: 'high' }),
    );
  });

  it('audits but does not open a task when the merchant captures at authorisation', async () => {
    merchants.findInternal.mockResolvedValueOnce({ captureAtSettlement: false });

    await consumer.handle(duplicateEvent(), tx as unknown as EntityManager);

    expect(audit.record).toHaveBeenCalled();
    expect(supportTasks.open).not.toHaveBeenCalled();
  });

  it('survives an unattributed duplicate (orphaned item, null charge and merchant)', async () => {
    await consumer.handle(
      duplicateEvent({ charge_id: null, merchant_id: null }),
      tx as unknown as EntityManager,
    );

    expect(audit.record).toHaveBeenCalled();
    expect(supportTasks.open).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'settlement.duplicate_unattributed',
      expect.objectContaining({ item_id: 'rci_9' }),
    );
  });

  describe('payout emails (RFC platform-v2 §2)', () => {
    function payoutEvent(type: 'payout.paid' | 'payout.failed' | 'payout.returned', payload: object): PayzenoEvent {
      return {
        id: `evt_${type}`,
        type,
        version: 1,
        occurred_at: '2026-03-02T09:00:00.000Z',
        source: 'payzeno-ledger',
        correlation_id: 'po_1',
        causation_id: null,
        merchant_id: 'mch_1',
        livemode: true,
        payload: { payout_id: 'po_1', merchant_id: 'mch_1', amount_minor: 125_000, currency: 'EUR', ...payload },
      } as PayzenoEvent;
    }

    it('tells the owners and admins a payout was paid, in the handler transaction', async () => {
      await consumer.handle(
        payoutEvent('payout.paid', { ledger_transaction_id: 'txn_1', paid_at: '2026-03-02T09:00:00.000Z' }),
        tx as unknown as EntityManager,
      );

      expect(audit.record).toHaveBeenCalled();
      expect(bankAccounts.findDefault).toHaveBeenCalledWith('mch_1', 'EUR', true);
      expect(mailer.queueToAdmins).toHaveBeenCalledWith(
        'mch_1',
        'payout_paid',
        { amount: '€1,250.00', bank_last4: '4321' },
        { manager: tx, livemode: true },
      );
    });

    it('names the failed account and the bank’s reason on payout.failed', async () => {
      await consumer.handle(
        payoutEvent('payout.failed', {
          bank_account_id: 'ba_1',
          failure_code: 'account_closed',
          failure_message: 'Account closed',
          reversal_transaction_id: 'txn_r',
          requires_merchant_action: true,
          retry_scheduled_for: null,
          failed_at: '2026-03-02T09:00:00.000Z',
        }),
        tx as unknown as EntityManager,
      );

      expect(bankAccounts.findOne).toHaveBeenCalledWith({ where: { id: 'ba_1' } });
      expect(mailer.queueToAdmins).toHaveBeenCalledWith(
        'mch_1',
        'payout_failed',
        { amount: '€1,250.00', bank_last4: '6789', failure_reason: 'Account closed' },
        expect.objectContaining({ manager: tx }),
      );
    });

    it('treats a bank return as a failed payout for the merchant', async () => {
      await consumer.handle(
        payoutEvent('payout.returned', {
          return_code: 'R01',
          reversal_transaction_id: 'txn_r',
          returned_at: '2026-03-04T09:00:00.000Z',
        }),
        tx as unknown as EntityManager,
      );

      expect(mailer.queueToAdmins).toHaveBeenCalledWith(
        'mch_1',
        'payout_failed',
        expect.objectContaining({ failure_reason: 'returned by the bank (R01)' }),
        expect.anything(),
      );
    });
  });
});
