/**
 * Billing-period and retry-schedule arithmetic. L5, pure — no clock, no I/O.
 *
 * Periods are calendar periods in UTC: a subscription started on the 31st renews on the last
 * day of shorter months and goes back to the 31st when it can, because each period end is
 * computed from the ANCHOR (the first period's start) rather than from the previous end. That
 * is also what makes catch-up after a clock jump exact: period n ends at anchor + n intervals,
 * whatever day the job noticed it.
 */
import type { Recurring } from '@payzeno/contracts';

const DAY_MS = 86_400_000;

/** RFC §6: retries at +1d, +3d and +7d after the first failed renewal, then cancel. */
export const RENEWAL_RETRY_OFFSETS_DAYS: readonly number[] = [1, 3, 7];

/** The initial attempt plus one per retry. The attempt after this many failures does not happen. */
export const MAX_RENEWAL_ATTEMPTS = RENEWAL_RETRY_OFFSETS_DAYS.length + 1;

function monthsOf(recurring: Recurring): number {
  return recurring.interval === 'year' ? 12 * recurring.interval_count : recurring.interval_count;
}

/** `anchor` plus `periods` whole intervals, clamped to the end of a shorter month. */
export function addIntervals(anchor: Date, recurring: Recurring, periods: number): Date {
  const months = monthsOf(recurring) * periods;
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/**
 * The period after the one ending at `currentEnd`, for a subscription anchored at `anchor`.
 * Counts how many intervals `currentEnd` is from the anchor so a clamped end (Feb 28) still
 * leads to the anchored day (Mar 31), not to Mar 28.
 */
export function nextPeriod(anchor: Date, currentEnd: Date, recurring: Recurring): { start: Date; end: Date } {
  let n = 1;
  while (addIntervals(anchor, recurring, n).getTime() < currentEnd.getTime()) n += 1;
  return { start: currentEnd, end: addIntervals(anchor, recurring, n + 1) };
}

/**
 * When the next automatic retry is due after `failedAttempts` failures that began at
 * `pastDueSince`, or null when the last one has failed and the subscription should cancel.
 */
export function nextRetryAt(pastDueSince: Date, failedAttempts: number): Date | null {
  if (failedAttempts < 1 || failedAttempts >= MAX_RENEWAL_ATTEMPTS) return null;
  return new Date(pastDueSince.getTime() + RENEWAL_RETRY_OFFSETS_DAYS[failedAttempts - 1] * DAY_MS);
}
