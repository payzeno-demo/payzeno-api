import { ReportingService } from './reporting.service';

describe('ReportingService', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');

  let volumes: { counts: jest.Mock; disputeCount: jest.Mock; run: jest.Mock };
  let ledger: { getBalance: jest.Mock; getBalanceHistory: jest.Mock; listPayouts: jest.Mock };
  let logger: Record<string, jest.Mock>;
  let service: ReportingService;

  beforeEach(() => {
    volumes = {
      counts: jest.fn(async () => ({
        succeeded: 42,
        failed: 3,
        gross_minor: 500_000,
        refunded_minor: 25_000,
      })),
      disputeCount: jest.fn(async () => 2),
      run: jest.fn(async () => [
        { bucket_start: '2026-05-31T00:00:00.000Z', amount_minor: 100, count: 1 },
      ]),
    };
    ledger = {
      getBalance: jest.fn(async () => ({ available_minor: 1_000, pending_minor: 200 })),
      getBalanceHistory: jest.fn(async () => ({ points: [] })),
      listPayouts: jest.fn(async () => ({ data: [{ id: 'po_1' }], has_more: false })),
    };
    logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() };

    service = new ReportingService(
      volumes as never,
      ledger as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      logger as never,
    );
  });

  describe('summary', () => {
    it('nets refunds out of gross rather than recomputing from the ledger', async () => {
      const summary = await service.summary({
        merchantId: 'mch_1',
        currency: 'USD',
        livemode: true,
        window: '7d',
      });

      expect(summary.gross_volume_minor).toBe(500_000);
      expect(summary.refunded_minor).toBe(25_000);
      expect(summary.net_volume_minor).toBe(475_000);
      expect(summary.dispute_count).toBe(2);
      expect(summary.balance).toEqual({ available_minor: 1_000, pending_minor: 200 });
    });

    it('windows 24h/7d/30d back from now', async () => {
      await service.summary({
        merchantId: 'mch_1',
        currency: 'USD',
        livemode: true,
        window: '24h',
      });

      const [, , , from, to] = volumes.counts.mock.calls[0];
      expect(to).toEqual(now);
      expect(now.getTime() - (from as Date).getTime()).toBe(24 * 3_600_000);
    });

    it('asks the ledger for exactly one scheduled payout', async () => {
      await service.summary({
        merchantId: 'mch_1',
        currency: 'USD',
        livemode: true,
        window: '30d',
      });

      expect(ledger.listPayouts).toHaveBeenCalledWith('mch_1', { status: 'scheduled', limit: 1 });
    });

    it('reports a null next payout when the merchant has none scheduled', async () => {
      ledger.listPayouts.mockResolvedValueOnce({ data: [], has_more: false });

      const summary = await service.summary({
        merchantId: 'mch_1',
        currency: 'USD',
        livemode: true,
        window: '7d',
      });

      expect(summary.next_payout).toBeNull();
    });
  });

  describe('volume', () => {
    it('defaults to the gross series', async () => {
      await service.volume({
        merchantId: 'mch_1',
        currency: 'USD',
        livemode: true,
        interval: 'day',
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      });

      expect(volumes.run).toHaveBeenCalledWith(expect.objectContaining({ series: 'gross' }));
    });

    it('warns when the console asks for an absurd number of points', async () => {
      volumes.run.mockResolvedValueOnce(
        Array.from({ length: 801 }, () => ({
          bucket_start: '2026-05-31T00:00:00.000Z',
          amount_minor: 1,
          count: 1,
        })),
      );

      await service.volume({
        merchantId: 'mch_1',
        currency: 'USD',
        livemode: true,
        interval: 'hour',
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      });

      expect(logger.warn).toHaveBeenCalledWith(
        'reporting.volume_oversized',
        expect.objectContaining({ points: 801 }),
      );
    });
  });

  it('balanceHistory is a straight read-through with no local cache', async () => {
    await service.balanceHistory(
      'mch_1',
      'USD',
      '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      'day',
    );

    expect(ledger.getBalanceHistory).toHaveBeenCalledWith('mch_1', {
      currency: 'USD',
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-06-01T00:00:00.000Z',
      interval: 'day',
    });
  });
});
