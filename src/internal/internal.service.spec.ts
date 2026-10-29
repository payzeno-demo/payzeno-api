import type { EntityManager } from 'typeorm';

import { ChargeNotFoundException, MerchantNotFoundException } from '../common/errors/not-found.exceptions';

import { InternalService } from './internal.service';

describe('InternalService', () => {
  const now = new Date('2026-06-11T02:40:00.000Z');

  let merchants: { findInternal: jest.Mock };
  let charges: { getInternal: jest.Mock; markSettledFromBatch: jest.Mock };
  let bankAccounts: { getForInternal: jest.Mock };
  let webhookEndpoints: { listForInternalCaller: jest.Mock };
  let supportTasks: { open: jest.Mock };
  let audit: { record: jest.Mock };
  let logger: Record<string, jest.Mock>;
  let service: InternalService;
  const tx = { id: 'tx' } as unknown as EntityManager;

  beforeEach(() => {
    merchants = { findInternal: jest.fn(async () => ({ id: 'mch_1', capture_at_settlement: true })) };
    charges = {
      getInternal: jest.fn(async () => ({ id: 'ch_1', status: 'settled' })),
      markSettledFromBatch: jest.fn(async () => 1),
    };
    bankAccounts = {
      getForInternal: jest.fn(async () => ({ toBankAccount: () => ({ id: 'ba_1', scheme: 'aba' }) })),
    };
    webhookEndpoints = { listForInternalCaller: jest.fn(async () => [{ id: 'we_1' }]) };
    supportTasks = { open: jest.fn(async () => 'sup_1') };
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

  it('getCharge raises ChargeNotFoundException for an orphan the ledger cannot resolve', async () => {
    charges.getInternal.mockRejectedValueOnce(new ChargeNotFoundException('ch_missing'));

    await expect(service.getCharge('ch_missing', 'payzeno-ledger')).rejects.toBeInstanceOf(
      ChargeNotFoundException,
    );
  });

  describe('markChargeSettled', () => {
    const input = {
      settlement_batch_id: 'sb_1',
      settled_at: '2026-06-11T02:39:00.000Z',
      transaction_id: 'txn_1',
    };

    it('reuses the event branch write path and audits under internal_service', async () => {
      await service.markChargeSettled('ch_1', input, 'payzeno-ledger');

      expect(charges.markSettledFromBatch).toHaveBeenCalledWith(tx, ['ch_1'], {
        settlementBatchId: 'sb_1',
        settledAt: input.settled_at,
      });
      expect(audit.record).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          actorType: 'internal_service',
          actorId: 'payzeno-ledger',
          action: 'charge.settled.out_of_band',
          resourceId: 'ch_1',
        }),
      );
    });

    it('warns but still audits when the update affected no rows', async () => {
      charges.markSettledFromBatch.mockResolvedValueOnce(0);

      await service.markChargeSettled('ch_1', input, 'payzeno-ledger');

      expect(logger.warn).toHaveBeenCalledWith(
        'internal.charge_settle_noop',
        expect.objectContaining({ charge_id: 'ch_1' }),
      );
      expect(audit.record).toHaveBeenCalledTimes(1);
    });
  });

  it('createSupportTask opens the task and audits it in one transaction', async () => {
    const result = await service.createSupportTask(
      {
        kind: 'duplicate_settlement',
        merchant_id: 'mch_1',
        charge_id: 'ch_9',
        severity: 'high',
        title: 'Possible double charge on ch_9',
        body: 'ledger refused a second posting',
        source_event_id: 'evt_1',
      },
      'payzeno-ledger',
    );

    expect(result).toEqual({ id: 'sup_1' });
    expect(supportTasks.open).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ kind: 'duplicate_settlement', chargeId: 'ch_9' }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'support_task.open', resourceId: 'sup_1' }),
    );
  });

  it('listWebhookEndpoints answers from the table, never from a projection', async () => {
    const page = await service.listWebhookEndpoints('mch_1', 'enabled', 'payzeno-ledger');

    expect(webhookEndpoints.listForInternalCaller).toHaveBeenCalledWith('mch_1', 'enabled');
    expect(page).toEqual({ data: [{ id: 'we_1' }], has_more: false });
  });
});
