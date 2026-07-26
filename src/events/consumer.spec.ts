import type { Message } from '@aws-sdk/client-sqs';
import type { EntityManager } from 'typeorm';
import type { EventType, PayzenoEvent } from '@payzeno/contracts/events';
import { BaseEventConsumer } from './consumer';

class FakeSqs {
  readonly deleted: string[] = [];
  send = jest.fn(async (command: { input?: Record<string, unknown> }) => {
    const handle = command.input?.ReceiptHandle;
    if (typeof handle === 'string') {
      this.deleted.push(handle);
    }
    return {};
  });
}

class RecordingConsumer extends BaseEventConsumer {
  readonly queueUrl = 'http://localstack:4566/000000000000/payzeno-api-ledger';
  readonly consumerName = 'recording';
  readonly handledTypes = new Set<EventType>(['settlement.completed', 'payout.failed']);
  readonly handled: PayzenoEvent[] = [];
  shouldThrow = false;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handle(event: PayzenoEvent, _tx: EntityManager): Promise<void> {
    if (this.shouldThrow) {
      throw new Error('handler blew up');
    }
    this.handled.push(event);
  }
}

function envelope(overrides: Partial<PayzenoEvent> = {}): Record<string, unknown> {
  return {
    id: 'evt_01HZZZ',
    type: 'settlement.completed',
    version: 2,
    occurred_at: '2026-03-01T10:00:00.000Z',
    source: 'payzeno-ledger',
    correlation_id: 'corr_1',
    causation_id: null,
    merchant_id: 'mer_1',
    livemode: true,
    payload: { batch_id: 'sbt_1' },
    ...overrides,
  };
}

function sqsMessage(body: unknown, receipt = 'rh-1'): Message {
  return { MessageId: 'm1', ReceiptHandle: receipt, Body: JSON.stringify(body) };
}

describe('BaseEventConsumer', () => {
  let sqs: FakeSqs;
  let claim: jest.Mock;
  let consumer: RecordingConsumer;

  const transactions = {
    runInTransaction: jest.fn(async (fn: (tx: EntityManager) => Promise<unknown>) =>
      fn({} as EntityManager),
    ),
  };

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    sqs = new FakeSqs();
    claim = jest.fn(async () => true);
    consumer = new RecordingConsumer(
      sqs as never,
      transactions as never,
      { claim } as never,
      logger as never,
    );
  });

  it('handles an event it declares and deletes the message', async () => {
    await consumer.processMessage(sqsMessage(envelope()));

    expect(consumer.handled).toHaveLength(1);
    expect(claim).toHaveBeenCalledWith(expect.anything(), 'evt_01HZZZ', 'recording');
    expect(sqs.deleted).toEqual(['rh-1']);
  });

  it('unwraps the SNS-to-SQS envelope', async () => {
    await consumer.processMessage(sqsMessage({ Message: JSON.stringify(envelope()) }));

    expect(consumer.handled).toHaveLength(1);
    expect(consumer.handled[0].id).toBe('evt_01HZZZ');
  });

  it('acknowledges and drops a type it does not handle', async () => {
    await consumer.processMessage(sqsMessage(envelope({ type: 'payment.captured' as EventType })));

    expect(consumer.handled).toHaveLength(0);
    expect(claim).not.toHaveBeenCalled();
    expect(sqs.deleted).toEqual(['rh-1']);
  });

  it('skips the handler entirely when the claim loses the race', async () => {
    claim.mockResolvedValueOnce(false);

    await consumer.processMessage(sqsMessage(envelope()));

    expect(consumer.handled).toHaveLength(0);
    // Still acknowledged: someone else did the work, the message is done.
    expect(sqs.deleted).toEqual(['rh-1']);
  });

  it('leaves the message on the queue when the handler throws', async () => {
    consumer.shouldThrow = true;

    await consumer.processMessage(sqsMessage(envelope()));

    expect(sqs.deleted).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'consumer.handler_failed',
      expect.any(Error),
      expect.objectContaining({ event_id: 'evt_01HZZZ' }),
    );
  });

  it('routes an unknown schema version to the DLQ instead of guessing', async () => {
    await consumer.processMessage(sqsMessage(envelope({ version: 99 })));

    expect(consumer.handled).toHaveLength(0);
    expect(sqs.deleted).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      'consumer.unknown_schema_version',
      expect.objectContaining({ version: 99, known_version: 2 }),
    );
  });

  it('does not delete an unparseable message', async () => {
    await consumer.processMessage({ MessageId: 'm2', ReceiptHandle: 'rh-2', Body: 'not json' });

    expect(sqs.deleted).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'consumer.unparseable_message',
      null,
      expect.objectContaining({ message_id: 'm2' }),
    );
  });
});
