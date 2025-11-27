import type { EntityManager } from 'typeorm';

import { ChargeNotFoundException, MerchantNotFoundException } from '../common/errors/not-found.exceptions';

import { InternalService } from './internal.service';

describe('InternalService', () => {
  const now = new Date('2026-06-11T02:40:00.000Z');

  let charges: { findInternal: jest.Mock; markSettledFromBatch: jest.Mock };
  let webhookEndpoints: { listForInternalCaller: jest.Mock };
  let supportTasks: { open: jest.Mock };
  let logger: Record<string, jest.Mock>;
  let service: InternalService;
  it('listWebhookEndpoints answers from the table, never from a projection', async () => {
    const page = await service.listWebhookEndpoints('mch_1', 'enabled', 'payzeno-ledger');

    expect(webhookEndpoints.listForInternalCaller).toHaveBeenCalledWith('mch_1', 'enabled');
    expect(page).toEqual({ data: [{ id: 'we_1' }], has_more: false });
  });
});
