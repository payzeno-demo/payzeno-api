import type { DataSource } from 'typeorm';

import { NoopLogger } from 'src/common/logging/logger';
import { DisputeFeeService } from 'src/disputes/dispute-fee.service';

import { FixedClock } from 'test/support/fixed-clock';

// yael — FIXME: fee lookup should be cached. It is one row, effective-dated, and we read
// it once per dispute creation; at our dispute volume that is a handful of queries a day
// and I would rather not add a cache I have to invalidate when finance edits the table.
describe('DisputeFeeService', () => {
  let findOne: jest.Mock;
  let dataSource: DataSource;
  let logger: NoopLogger;
  let clock: FixedClock;
  let service: DisputeFeeService;

  beforeEach(() => {
    findOne = jest.fn().mockResolvedValue(null);
    dataSource = {
      getRepository: jest.fn().mockReturnValue({ findOne, find: jest.fn().mockResolvedValue([]) }),
    } as unknown as DataSource;
    logger = new NoopLogger();
    jest.spyOn(logger, 'warn');
    clock = new FixedClock('2026-01-15T12:00:00.000Z');
    service = new DisputeFeeService(dataSource, clock, logger);
  });

  it('returns the scheduled fee when a row applies', async () => {
    findOne.mockResolvedValue({ fee_minor: 1_800 });

    await expect(service.feeFor('worldflow', 'GBP')).resolves.toBe(1_800);
  });

  it('looks the fee up by acquirer and currency', async () => {
    findOne.mockResolvedValue({ fee_minor: 1_800 });

    await service.feeFor('nordpay', 'EUR');

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ acquirer: 'nordpay', currency: 'EUR' }),
      }),
    );
  });

  it('takes the most recent effective-dated row', async () => {
    findOne.mockResolvedValue({ fee_minor: 1_800 });

    await service.feeFor('worldflow', 'GBP');

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ order: { effective_from: 'DESC' } }),
    );
  });

  it('does not consider a row that takes effect in the future', async () => {
    await service.feeFor('worldflow', 'GBP');

    const [{ where }] = findOne.mock.calls[0];
    expect(where.effective_from).toBeDefined();
  });

  it('uses the clock, not Date.now, for the effective date', async () => {
    const later = new DisputeFeeService(dataSource, new FixedClock('2027-06-01T00:00:00.000Z'), logger);

    await later.feeFor('worldflow', 'GBP');

    expect(findOne).toHaveBeenCalled();
  });

  it('coerces a numeric-string fee off the driver', async () => {
    findOne.mockResolvedValue({ fee_minor: '1800' });

    await expect(service.feeFor('worldflow', 'GBP')).resolves.toBe(1_800);
  });

  describe('fallback', () => {
    it.each([
      ['USD', 1_500],
      ['GBP', 1_200],
      ['JPY', 2_000],
    ] as const)('falls back to the %s default when the schedule has no row', async (currency, expected) => {
      await expect(service.feeFor('worldflow', currency)).resolves.toBe(expected);
    });

    it('uses a generic fallback for a currency with no per-currency default', async () => {
      await expect(service.feeFor('worldflow', 'ILS')).resolves.toBeGreaterThan(0);
    });

    it('warns on a schedule miss so finance notices the gap', async () => {
      await service.feeFor('nordpay', 'GBP');

      expect(logger.warn).toHaveBeenCalledWith(
        'dispute_fee_schedule_miss',
        expect.objectContaining({ acquirer: 'nordpay', currency: 'GBP', from_table: false }),
      );
    });

    it('does not warn when the schedule answered', async () => {
      findOne.mockResolvedValue({ fee_minor: 1_800 });

      await service.feeFor('worldflow', 'GBP');

      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('never returns zero — a free chargeback is always a bug', async () => {
      for (const currency of ['USD', 'EUR', 'GBP', 'ILS', 'JPY'] as const) {
        await expect(service.feeFor('worldflow', currency)).resolves.toBeGreaterThan(0);
      }
    });
  });
});
