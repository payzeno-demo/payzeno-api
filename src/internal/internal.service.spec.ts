import type { EntityManager } from 'typeorm';

import { ChargeNotFoundException, MerchantNotFoundException } from '../common/errors/not-found.exceptions';

import { InternalService } from './internal.service';

describe('InternalService', () => {
  const now = new Date('2026-06-11T02:40:00.000Z');

  let webhookEndpoints: { listForInternalCaller: jest.Mock };
  let supportTasks: { open: jest.Mock };
  let logger: Record<string, jest.Mock>;
});
