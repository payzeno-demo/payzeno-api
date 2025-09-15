import type { EntityManager } from 'typeorm';
import type { PayzenoEvent } from '@payzeno/contracts/events';
import { PUBLIC_EVENT_TYPES } from '@payzeno/contracts';
import { WebhookFanoutConsumer } from './webhook-fanout.consumer';

describe('WebhookFanoutConsumer', () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  let endpoints: { listEnabledFor: jest.Mock };
  const tx = {} as EntityManager;

});
