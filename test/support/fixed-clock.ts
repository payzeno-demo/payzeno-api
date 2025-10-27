import { BaseClock } from 'src/common/time/clock';

/**
 * The test-side `Clock` (blueprint §3.3 — `SystemClock` is production, `FixedClock` lives
 * here). `ChargeExpiryPolicy`, `RefundPolicyService`, `DisputeDeadlineReminderJob` and
 * every idempotency lease calculation are date arithmetic; without a controllable clock
 * they are either untestable or flaky at midnight UTC.
 *
 * It extends `BaseClock` rather than reimplementing `Clock`, so `nowIso`, `plusSeconds`
 * and `plusDays` are the *production* implementations under test, not a second copy.
 */
export class FixedClock extends BaseClock {
  private currentMs: number;

  constructor(initial: Date | string | number = '2026-01-15T12:00:00.000Z') {
    super();
    this.currentMs = toMs(initial);
  }

  nowMs(): number {
    return this.currentMs;
  }

  /** Move the clock forward. Negative values are allowed and used by the replay specs. */
  advanceMs(ms: number): this {
    this.currentMs += ms;
    return this;
  }

  advanceSeconds(seconds: number): this {
    return this.advanceMs(seconds * 1_000);
  }

  advanceMinutes(minutes: number): this {
    return this.advanceMs(minutes * 60_000);
  }

  advanceHours(hours: number): this {
    return this.advanceMs(hours * 3_600_000);
  }

  advanceDays(days: number): this {
    return this.advanceMs(days * 86_400_000);
  }

  set(to: Date | string | number): this {
    this.currentMs = toMs(to);
    return this;
  }
}

function toMs(value: Date | string | number): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return new Date(value).getTime();
  }
  return value.getTime();
}

/** Convenience for the many specs that only need "some fixed instant". */
export function frozenAt(iso: string): FixedClock {
  return new FixedClock(iso);
}
