import { EVENT_TYPES, type PayzenoEvent } from '@payzeno/contracts/events';
import type { EntityManager } from 'typeorm';
import { DeadLetterConsumer } from './dead-letter.consumer';

describe('DeadLetterConsumer', () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  const config = { aws: { sqsDlqUrl: 'http://localstack:4566/000000000000/payzeno-dlq-monitor' } };

  function parked(id: string) {
    const body = JSON.stringify({
      id,
      type: 'payout.failed',
      version: 1,
      occurred_at: '2026-05-01T00:00:00.000Z',
      source: 'payzeno-ledger',
      correlation_id: 'corr_1',
      causation_id: null,
      merchant_id: 'mer_1',
      livemode: true,
      payload: { payout_id: 'po_1', merchant_id: 'mer_1' },
    });
    return {
      MessageId: `m-${id}`,
      ReceiptHandle: `rh-${id}`,
      Body: body,
      MessageAttributes: {
        origin_queue_url: {
          DataType: 'String',
          StringValue: 'http://localstack:4566/000000000000/payzeno-api-ledger',
        },
      },
    };
  }

  let sent: Array<Record<string, unknown>>;
  let consumer: DeadLetterConsumer;

  beforeEach(() => {
    jest.clearAllMocks();
    sent = [];
    const sqs = {
      send: jest.fn(async (command: { input: Record<string, unknown>; constructor: { name: string } }) => {
        sent.push({ name: command.constructor.name, ...command.input });
        if (command.constructor.name === 'ReceiveMessageCommand') {
          return { Messages: [parked('evt_1')] };
        }
        return {};
      }),
    };

    consumer = new DeadLetterConsumer(
      sqs as never,
      { runInTransaction: async (fn: (tx: EntityManager) => Promise<unknown>) => fn({} as EntityManager) } as never,
      { claim: async () => true } as never,
      logger as never,
      config as never,
    );
  });

  it('claims every event type — the DLQ has no vocabulary of its own', () => {
    expect(consumer.handledTypes.size).toBe(EVENT_TYPES.length);
  });

  it('logs the parked envelope at error level so it shows up in triage', async () => {
    await consumer.handle(
      { id: 'evt_1', type: 'payout.failed', source: 'payzeno-ledger' } as PayzenoEvent,
      {} as EntityManager,
    );

    expect(logger.error).toHaveBeenCalledWith(
      'dlq.received',
      null,
      expect.objectContaining({ event_id: 'evt_1', type: 'payout.failed' }),
    );
  });

  it('redrives to the origin queue recorded by the redrive policy', async () => {
    const redriven = await consumer.runOnce();

    expect(redriven).toBe(1);
    const send = sent.find((entry) => entry.name === 'SendMessageCommand');
    expect(send?.QueueUrl).toBe('http://localstack:4566/000000000000/payzeno-api-ledger');
  });

  it('parks an envelope after three redrives instead of looping forever', async () => {
    await consumer.runOnce();
    await consumer.runOnce();
    await consumer.runOnce();
    const fourth = await consumer.runOnce();

    expect(fourth).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      'dlq.parked_redrive_exhausted',
      null,
      expect.objectContaining({ event_id: 'evt_1', attempts: 4 }),
    );
  });
});
