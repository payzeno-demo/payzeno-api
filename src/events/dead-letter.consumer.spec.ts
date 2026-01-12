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

});
