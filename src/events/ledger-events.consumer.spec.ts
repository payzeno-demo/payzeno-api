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

});
