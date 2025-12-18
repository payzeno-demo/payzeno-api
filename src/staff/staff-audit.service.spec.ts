import { StaffAuditLog } from './staff-user.entity';
import { REVIEWED_STAFF_ACTIONS, StaffAuditService } from './staff-audit.service';

describe('StaffAuditService', () => {
  const fixedNow = new Date('2026-04-02T11:00:00.000Z');

  let inserted: StaffAuditLog[];
  let stored: StaffAuditLog[];
  let logged: Array<{ msg: string; ctx?: Record<string, unknown> }>;
  let service: StaffAuditService;

  function entry(overrides: Partial<Parameters<StaffAuditService['record']>[0]> = {}) {
    return {
      staffId: 'stf_1',
      actingMerchantId: 'mch_1',
      action: 'merchant.status.change',
      resourceType: 'merchant',
      resourceId: 'mch_1',
      before: { status: 'active' },
      after: { status: 'suspended' },
      reason: 'dispute rate over 100bps',
      requestId: 'req_1',
      ip: '198.51.100.4',
      ...overrides,
    };
  }

  beforeEach(() => {
    inserted = [];
    stored = [];
    logged = [];

    const repo = {
      insert: jest.fn(async (row: StaffAuditLog) => {
        inserted.push(row);
        return { identifiers: [{ id: row.id }] };
      }),
      find: jest.fn(async () => stored),
    };

    service = new StaffAuditService(
      repo as never,
      { opaque: (prefix: string) => `${prefix}01HZSTAFFAUDIT0000000000` } as never,
      { now: () => fixedNow } as never,
      {
        info: (msg: string, ctx?: Record<string, unknown>) => logged.push({ msg, ctx }),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        child: jest.fn(),
      } as never,
    );
  });

  it('writes a staff_audit_log row with the acting merchant and the reason', async () => {
    const row = await service.record(entry());

    expect(inserted).toHaveLength(1);
    expect(row.staffId).toBe('stf_1');
    expect(row.actingMerchantId).toBe('mch_1');
    expect(row.reason).toBe('dispute rate over 100bps');
    expect(row.createdAt).toEqual(fixedNow);
    expect(row.id.startsWith('sal_')).toBe(true);
  });

  it('mirrors reviewed actions into the access log', async () => {
    await service.record(entry({ action: 'settlement.item.retry' }));

    const mirrored = logged.find((line) => line.msg === 'staff.reviewed_action');
    expect(mirrored).toBeDefined();
    expect(mirrored?.ctx).toMatchObject({ action: 'settlement.item.retry', has_reason: true });
  });

  it('does not mirror an ordinary read-shaped action', async () => {
    await service.record(entry({ action: 'merchant.get', reason: null }));

    expect(logged.find((line) => line.msg === 'staff.reviewed_action')).toBeUndefined();
  });

  it('writes through the caller transaction when one is supplied', async () => {
    const txInsert = jest.fn(async () => ({ identifiers: [] }));
    const tx = { getRepository: () => ({ insert: txInsert }) };

    await service.record(entry(), tx as never);

    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0);
  });

  describe('reviewWindow', () => {
    it('keeps only reviewed actions and counts the ones with no reason', async () => {
      stored = [
        rowWith('merchant.status.change', 'chargebacks'),
        rowWith('merchant.get', null),
        rowWith('dispute.accept', null),
        rowWith('settlement.item.retry', '   '),
      ];

      const result = await service.reviewWindow(
        new Date('2026-04-01T00:00:00.000Z'),
        new Date('2026-05-01T00:00:00.000Z'),
      );

      expect(result.rows).toHaveLength(3);
      expect(result.rows.every((row) => REVIEWED_STAFF_ACTIONS.includes(row.action))).toBe(true);
      expect(result.unexplained).toBe(2);
    });
  });

  function rowWith(action: string, reason: string | null): StaffAuditLog {
    const row = new StaffAuditLog();
    row.id = `sal_${action}`;
    row.staffId = 'stf_1';
    row.actingMerchantId = 'mch_1';
    row.action = action;
    row.resourceType = 'merchant';
    row.resourceId = 'mch_1';
    row.before = null;
    row.after = null;
    row.reason = reason;
    row.requestId = null;
    row.ip = null;
    row.createdAt = fixedNow;
    return row;
  }
});
