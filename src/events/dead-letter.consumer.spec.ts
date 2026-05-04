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

  const config = { SQS_DLQ_URL: 'http://localstack:4566/000000000000/payzeno-dlq-monitor' };

  let sent: Array<Record<string, unknown>>;
  let consumer: DeadLetterConsumer;

  it('claims every event type — the DLQ has no vocabulary of its own', () => {
    expect(consumer.handledTypes.size).toBe(EVENT_TYPES.length);
  });

  it('redrives to the origin queue recorded by the redrive policy', async () => {
    const redriven = await consumer.runOnce();

    expect(redriven).toBe(1);
    const send = sent.find((entry) => entry.name === 'SendMessageCommand');
    expect(send?.QueueUrl).toBe('http://localstack:4566/000000000000/payzeno-api-ledger');
  });

});
