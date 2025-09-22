import type { EntityManager } from 'typeorm';

import { AuditLog } from './audit-log.entity';
import { AuditService } from './audit.service';

describe('AuditService', () => {
  const fixedNow = new Date('2026-05-01T09:15:00.000Z');

  let appended: Array<{ row: AuditLog; manager?: EntityManager }>;
  let service: AuditService;
  let staffRecord: jest.Mock;

  beforeEach(() => {
    appended = [];
    staffRecord = jest.fn(async () => undefined);

    const rows = {
      append: jest.fn(async (row: AuditLog, manager?: EntityManager) => {
        appended.push({ row, manager });
        return row;
      }),
      appendMany: jest.fn(async (batch: AuditLog[], manager?: EntityManager) => {
        for (const row of batch) {
          appended.push({ row, manager });
        }
        return batch.length;
      }),
      listForMerchant: jest.fn(async () => []),
      timelineFor: jest.fn(async () => []),
    };

    const ids = { opaque: jest.fn((prefix: string) => `${prefix}01HZTESTULID0000000000000`) };
    const clock = { now: () => fixedNow, nowMs: () => fixedNow.getTime() };

    service = new AuditService(
      rows as never,
      ids as never,
      { record: staffRecord } as never,
      clock as never,
    );
  });

  describe('record(entry)', () => {
    it('writes an audit_log row outside any transaction for the HTTP path', async () => {
      await service.record({
        merchantId: 'mch_1',
        actorType: 'user',
        actorId: 'usr_1',
        action: 'merchant.update',
        resourceType: 'merchant',
        resourceId: 'mch_1',
        before: { display_name: 'Old' },
        after: { display_name: 'New' },
        requestId: 'req_1',
        ip: '203.0.113.9',
        livemode: true,
      });

      expect(appended).toHaveLength(1);
      expect(appended[0].manager).toBeUndefined();
      expect(appended[0].row.action).toBe('merchant.update');
      expect(appended[0].row.before).toEqual({ display_name: 'Old' });
      expect(appended[0].row.requestId).toBe('req_1');
      expect(appended[0].row.createdAt).toEqual(fixedNow);
    });

    it('coerces a non-object before/after into jsonb-safe shape', async () => {
      await service.record({
        merchantId: null,
        actorType: 'system',
        actorId: 'payzeno-ledger',
        action: 'payout.failed',
        resourceType: 'payout',
        resourceId: 'po_1',
        before: undefined,
        after: 'raw string',
        requestId: 'req_2',
        ip: null,
        livemode: true,
      });

      expect(appended[0].row.before).toBeNull();
      expect(appended[0].row.after).toEqual({ value: 'raw string' });
    });
  });

  describe('record(tx, entry)', () => {
    it('writes through the caller transaction so the row commits with the handler', async () => {
      const tx = { marker: 'the-consumer-tx' } as unknown as EntityManager;

      await service.record(tx, {
        merchantId: 'mch_2',
        actorType: 'system',
        actorId: 'payzeno-ledger',
        action: 'settlement.duplicate_detected',
        resourceType: 'charge',
        resourceId: 'ch_9',
        before: null,
        after: { batch_id: 'sb_1', detected_by: 'retry_scheduler' },
        livemode: true,
      });

      expect(appended[0].manager).toBe(tx);
      expect(appended[0].row.resourceId).toBe('ch_9');
      expect(appended[0].row.after).toEqual({ batch_id: 'sb_1', detected_by: 'retry_scheduler' });
    });

    it('tolerates a null resource id — an orphaned item has no charge', async () => {
      const tx = {} as EntityManager;

      await service.record(tx, {
        merchantId: null,
        actorType: 'system',
        actorId: 'payzeno-ledger',
        action: 'settlement.duplicate_detected',
        resourceType: 'charge',
        resourceId: null,
        before: null,
        after: { item_id: 'ri_7' },
        livemode: true,
      });

      expect(appended[0].row.resourceId).toBeNull();
      expect(appended[0].row.merchantId).toBeNull();
    });
  });

  it('delegates recordStaff to StaffAuditService rather than writing audit_log', async () => {
    await service.recordStaff({
      staffId: 'stf_1',
      actingMerchantId: 'mch_1',
      action: 'merchant.status.change',
      resourceType: 'merchant',
      resourceId: 'mch_1',
      before: null,
      after: { status: 'suspended' },
      reason: 'chargeback rate',
      requestId: 'req_3',
      ip: null,
    });

    expect(staffRecord).toHaveBeenCalledTimes(1);
    expect(appended).toHaveLength(0);
  });

  it('recordMany writes every row through one manager', async () => {
    const tx = {} as EntityManager;
    const written = await service.recordMany(tx, [
      {
        merchantId: 'mch_3',
        actorType: 'staff',
        actorId: 'stf_2',
        action: 'merchant.create',
        resourceType: 'merchant',
        resourceId: 'mch_3',
        before: null,
        after: { legal_name: 'Acme' },
        livemode: true,
      },
      {
        merchantId: 'mch_3',
        actorType: 'staff',
        actorId: 'stf_2',
        action: 'bank_account.create',
        resourceType: 'bank_account',
        resourceId: 'ba_1',
        before: null,
        after: { scheme: 'aba' },
        livemode: true,
      },
    ]);

    expect(written).toBe(2);
    expect(appended.every((entry) => entry.manager === tx)).toBe(true);
  });
});
