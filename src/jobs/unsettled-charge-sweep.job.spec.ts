import 'reflect-metadata';

import { InMemoryLock } from '../common/lock/distributed-lock';

import { UnsettledChargeSweepJob } from './unsettled-charge-sweep.job';

/**
 * PAY-2058. The point of this suite is the two branches the incident actually produced:
 * a charge the ledger DID settle (we lost the event) and a charge it did not (we lost the
 * money, or there is an orphan). The second one must be loud.
 */
describe('UnsettledChargeSweepJob', () => {
  const now = new Date('2026-05-06T00:00:00.000Z');
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  function charge(id: string) {
    return {
      id,
      merchantId: 'mch_1',
      captured_at: new Date('2026-05-01T00:00:00.000Z'),
      amount_minor: 10_000,
      currency: 'USD',
      livemode: true,
    };
  }

  const settlementTransaction = {
    id: 'txn_1',
    purpose: 'settle',
    posted_at: '2026-05-02T02:00:00.000Z',
    metadata: { settlement_batch_id: 'sb_1' },
  };

  let charges: { findStrandedCaptures: jest.Mock; markSettled: jest.Mock };
  let ledger: { listTransactions: jest.Mock };
  let job: UnsettledChargeSweepJob;

  beforeEach(() => {
    jest.clearAllMocks();
    charges = {
      findStrandedCaptures: jest.fn(async () => [charge('ch_1')]),
      markSettled: jest.fn(async () => 1),
    };
    ledger = {
      listTransactions: jest.fn(async () => ({ data: [settlementTransaction], has_more: false })),
    };

    job = new UnsettledChargeSweepJob(
      charges as never,
      ledger as never,
      {
        runInTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
      } as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      new InMemoryLock(),
      logger as never,
    );
  });

  it('only looks at charges captured outside the settlement SLA', async () => {
    await job.runOnce();

    const [cutoff] = charges.findStrandedCaptures.mock.calls[0];
    expect(now.getTime() - (cutoff as Date).getTime()).toBe(72 * 3_600_000);
  });

  it('heals a charge the ledger settled, stamping the batch from the transaction', async () => {
    const result = await job.runOnce();

    expect(ledger.listTransactions).toHaveBeenCalledWith({
      merchant_id: 'mch_1',
      reference_type: 'charge',
      reference_id: 'ch_1',
      limit: 20,
    });
    expect(charges.markSettled).toHaveBeenCalledWith(
      {},
      ['ch_1'],
      'sb_1',
      new Date('2026-05-02T02:00:00.000Z'),
    );
    expect(result.details).toMatchObject({ healed: 1, unresolved: 0 });
  });

  it('alarms — loudly — on a charge the ledger has never settled', async () => {
    ledger.listTransactions.mockResolvedValueOnce({ data: [], has_more: false });

    const result = await job.runOnce();

    expect(charges.markSettled).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ healed: 0, unresolved: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      'sweep.unresolved_charges',
      null,
      expect.objectContaining({ unresolved: 1 }),
    );
  });

  it('will not guess a batch id when the settle posting carries none', async () => {
    ledger.listTransactions.mockResolvedValueOnce({
      data: [{ ...settlementTransaction, metadata: {} }],
      has_more: false,
    });

    await job.runOnce();

    expect(charges.markSettled).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      'sweep.settlement_without_batch',
      expect.objectContaining({ charge_id: 'ch_1' }),
    );
  });

  it('ignores non-settlement postings on the same charge', async () => {
    ledger.listTransactions.mockResolvedValueOnce({
      data: [
        { id: 'txn_hold', purpose: 'auth_hold', posted_at: '2026-05-01T00:00:00.000Z', metadata: {} },
      ],
      has_more: false,
    });

    const result = await job.runOnce();

    expect(result.details).toMatchObject({ unresolved: 1 });
  });

  it('treats a lost race as nothing wrong when the chunk arrived meanwhile', async () => {
    charges.markSettled.mockResolvedValueOnce(0);

    const result = await job.runOnce();

    expect(result.details).toMatchObject({ healed: 0, unresolved: 1 });
    expect(result.failed).toBe(0);
  });

  it('counts a throwing charge as failed and carries on', async () => {
    charges.findStrandedCaptures.mockResolvedValueOnce([charge('ch_1'), charge('ch_2')]);
    ledger.listTransactions
      .mockRejectedValueOnce(new Error('ledger unavailable'))
      .mockResolvedValueOnce({ data: [settlementTransaction], has_more: false });

    const result = await job.runOnce();

    expect(result.failed).toBe(1);
    expect(result.details).toMatchObject({ healed: 1 });
  });
});
