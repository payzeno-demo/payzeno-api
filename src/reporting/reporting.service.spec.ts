import { ReportingService } from './reporting.service';

describe('ReportingService', () => {
  const now = new Date('2026-06-01T12:00:00.000Z');

  let ledger: { getBalance: jest.Mock; getBalanceHistory: jest.Mock; listPayouts: jest.Mock };
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
