import {
  addIntervals,
  MAX_RENEWAL_ATTEMPTS,
  nextPeriod,
  nextRetryAt,
} from 'src/billing/recurring/billing-period';

const MONTHLY = { interval: 'month', interval_count: 1 } as const;
const YEARLY = { interval: 'year', interval_count: 1 } as const;

describe('billing-period', () => {
  describe('addIntervals', () => {
    it('adds calendar months in UTC, keeping the time of day', () => {
      expect(addIntervals(new Date('2026-10-29T08:30:00Z'), MONTHLY, 1).toISOString()).toBe('2026-11-29T08:30:00.000Z');
      expect(addIntervals(new Date('2026-12-15T00:00:00Z'), MONTHLY, 1).toISOString()).toBe('2027-01-15T00:00:00.000Z');
    });

    it('clamps to the end of a shorter month', () => {
      expect(addIntervals(new Date('2027-01-31T00:00:00Z'), MONTHLY, 1).toISOString()).toBe('2027-02-28T00:00:00.000Z');
      expect(addIntervals(new Date('2028-01-31T00:00:00Z'), MONTHLY, 1).toISOString()).toBe('2028-02-29T00:00:00.000Z');
    });

    it('handles years and multi-month counts', () => {
      expect(addIntervals(new Date('2026-10-29T00:00:00Z'), YEARLY, 1).toISOString()).toBe('2027-10-29T00:00:00.000Z');
      expect(
        addIntervals(new Date('2026-10-29T00:00:00Z'), { interval: 'month', interval_count: 3 }, 2).toISOString(),
      ).toBe('2027-04-29T00:00:00.000Z');
    });
  });

  describe('nextPeriod', () => {
    it('starts where the current one ends', () => {
      const anchor = new Date('2026-10-29T08:00:00Z');
      const next = nextPeriod(anchor, new Date('2026-11-29T08:00:00Z'), MONTHLY);
      expect(next.start.toISOString()).toBe('2026-11-29T08:00:00.000Z');
      expect(next.end.toISOString()).toBe('2026-12-29T08:00:00.000Z');
    });

    it('returns to the anchored day after a clamped month', () => {
      const anchor = new Date('2027-01-31T00:00:00Z');
      const next = nextPeriod(anchor, new Date('2027-02-28T00:00:00Z'), MONTHLY);
      expect(next.end.toISOString()).toBe('2027-03-31T00:00:00.000Z');
    });
  });

  describe('nextRetryAt', () => {
    const since = new Date('2026-11-29T08:00:00Z');

    it('schedules +1d, +3d, +7d from the first failure', () => {
      expect(nextRetryAt(since, 1)?.toISOString()).toBe('2026-11-30T08:00:00.000Z');
      expect(nextRetryAt(since, 2)?.toISOString()).toBe('2026-12-02T08:00:00.000Z');
      expect(nextRetryAt(since, 3)?.toISOString()).toBe('2026-12-06T08:00:00.000Z');
    });

    it('has no retry after the last one failed', () => {
      expect(MAX_RENEWAL_ATTEMPTS).toBe(4);
      expect(nextRetryAt(since, 4)).toBeNull();
      expect(nextRetryAt(since, 0)).toBeNull();
    });
  });
});
