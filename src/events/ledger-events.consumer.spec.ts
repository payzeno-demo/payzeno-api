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
    SQS_LEDGER_QUEUE_URL: 'http://localstack:4566/000000000000/payzeno-api-ledger',
  };

  let charges: { markSettledFromBatch: jest.Mock };
  let merchants: { findInternal: jest.Mock };
  let supportTasks: { open: jest.Mock };
  let tx: { query: jest.Mock; findOneBy: jest.Mock; update: jest.Mock };
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
    merchants = { findInternal: jest.fn(async () => ({ capture_at_settlement: true })) };
    audit = { record: jest.fn(async () => undefined) };
    supportTasks = { open: jest.fn(async () => 'stk_1') };
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
          return supportTasks;
        },
      } as never,
    );
    consumer.onModuleInit();
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

});
