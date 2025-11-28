import type { EntityManager } from 'typeorm';

import { ChargeNotFoundException, MerchantNotFoundException } from '../common/errors/not-found.exceptions';

import { InternalService } from './internal.service';

describe('InternalService', () => {
  const now = new Date('2026-06-11T02:40:00.000Z');

  let charges: { findInternal: jest.Mock; markSettledFromBatch: jest.Mock };
  let bankAccounts: { findInternal: jest.Mock };
  let webhookEndpoints: { listForInternalCaller: jest.Mock };
  let supportTasks: { open: jest.Mock };
  let logger: Record<string, jest.Mock>;
  let service: InternalService;
  beforeEach(() => {
    merchants = { findInternal: jest.fn(async () => ({ id: 'mch_1', capture_at_settlement: true })) };
    charges = {
      findInternal: jest.fn(async () => ({ id: 'ch_1', status: 'settled' })),
      markSettledFromBatch: jest.fn(async () => 1),
    };
    bankAccounts = { findInternal: jest.fn(async () => ({ id: 'ba_1', scheme: 'aba' })) };
    webhookEndpoints = { listForInternalCaller: jest.fn(async () => [{ id: 'we_1' }]) };
    supportTasks = { open: jest.fn(async () => ({ id: 'sup_1' })) };
    audit = { record: jest.fn(async () => undefined) };
    logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() };

    service = new InternalService(
      merchants as never,
      charges as never,
      bankAccounts as never,
      webhookEndpoints as never,
      supportTasks as never,
      { runInTransaction: async (fn: (m: EntityManager) => Promise<unknown>) => fn(tx) } as never,
      audit as never,
      { now: () => now, nowIso: () => now.toISOString() } as never,
      logger as never,
    );
  });

  it('getMerchant raises MerchantNotFoundException rather than returning null', async () => {
    merchants.findInternal.mockResolvedValueOnce(null);

    await expect(service.getMerchant('mch_missing', 'payzeno-ledger')).rejects.toBeInstanceOf(
      MerchantNotFoundException,
    );
  });

  it('listWebhookEndpoints answers from the table, never from a projection', async () => {
    const page = await service.listWebhookEndpoints('mch_1', 'enabled', 'payzeno-ledger');

    expect(webhookEndpoints.listForInternalCaller).toHaveBeenCalledWith('mch_1', 'enabled');
    expect(page).toEqual({ data: [{ id: 'we_1' }], has_more: false });
  });
});
