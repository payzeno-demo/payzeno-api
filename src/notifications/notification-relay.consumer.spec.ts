import type { PayzenoEvent } from '@payzeno/contracts/events';
import type { EntityManager } from 'typeorm';

import { NotificationRelayConsumer } from './notification-relay.consumer';

describe('NotificationRelayConsumer', () => {
  const tx = {} as EntityManager;

  let push: jest.Mock;
  let logger: Record<string, jest.Mock>;
  let consumer: NotificationRelayConsumer;

  function envelope(overrides: Partial<PayzenoEvent> & { type: string; payload: unknown }) {
    return {
      id: 'evt_1',
      version: 1,
      occurred_at: '2026-05-01T04:00:00.000Z',
      source: 'payzeno-ledger',
      correlation_id: 'corr_1',
      causation_id: null,
      merchant_id: 'mch_1',
      livemode: true,
      ...overrides,
    } as unknown as PayzenoEvent;
  }

  beforeEach(() => {
    push = jest.fn(() => 1);
    logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() };

    consumer = new NotificationRelayConsumer(
      { send: jest.fn() } as never,
      { runInTransaction: jest.fn() } as never,
      { claim: jest.fn(async () => true) } as never,
      logger as never,
      {
        aws: {
          sqsConsoleNotificationsUrl: 'http://localstack:4566/000000000000/payzeno-console-notifications',
        },
      } as never,
      { push } as never,
    );
  });

  it('binds to the console notifications queue', () => {
    expect(consumer.queueUrl).toContain('payzeno-console-notifications');
    expect(consumer.consumerName).toBe('notification-relay');
  });

  it('handles exactly the three relayed types and nothing else', () => {
    expect([...consumer.handledTypes].sort()).toEqual([
      'dispute.opened',
      'payout.failed',
      'settlement.completed',
    ]);
  });

  it('pushes a critical notification for a payout failure that needs merchant action', async () => {
    await consumer.handle(
      envelope({
        type: 'payout.failed',
        payload: {
          payout_id: 'po_1',
          merchant_id: 'mch_1',
          bank_account_id: 'ba_1',
          amount_minor: 42_000,
          currency: 'USD',
          failure_code: 'account_closed',
          failure_message: 'The receiving account is closed.',
          reversal_transaction_id: 'txn_1',
          requires_merchant_action: true,
          retry_scheduled_for: null,
          failed_at: '2026-05-01T04:00:00.000Z',
        },
      }),
      tx,
    );

    expect(push).toHaveBeenCalledTimes(1);
    const pushed = push.mock.calls[0][0];
    expect(pushed.severity).toBe('critical');
    expect(pushed.href).toBe('/payouts/po_1');
    expect(pushed.id).toBe('ntf_evt_1');
  });

  it('skips an untenanted settlement.completed instead of guessing a merchant', async () => {
    await consumer.handle(
      envelope({
        type: 'settlement.completed',
        merchant_id: null,
        payload: {
          batch_id: 'sb_1',
          run_id: 'rr_1',
          items_total: 10,
          items_settled: 10,
          items_failed: 0,
          currency: 'USD',
          processing_date: '2026-05-01',
          net_total_minor: 1000,
        },
      }),
      tx,
    );

    expect(push).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      'notification.skipped_untenanted',
      expect.objectContaining({ event_id: 'evt_1' }),
    );
  });

  it('logs a zero-socket delivery as a normal outcome', async () => {
    push.mockReturnValueOnce(0);

    await consumer.handle(
      envelope({
        type: 'dispute.opened',
        payload: {
          dispute_id: 'dp_1',
          charge_id: 'ch_1',
          merchant_id: 'mch_1',
          amount_minor: 5_000,
          fee_minor: 1_500,
          currency: 'USD',
          reason: 'fraudulent',
          network_reason_code: '10.4',
          evidence_due_by: '2026-05-15T00:00:00.000Z',
          opened_at: '2026-05-01T04:00:00.000Z',
        },
      }),
      tx,
    );

    expect(logger.info).toHaveBeenCalledWith(
      'notification.relayed',
      expect.objectContaining({ sockets: 0, severity: 'critical' }),
    );
    expect(logger.error).not.toHaveBeenCalled();
  });
});
