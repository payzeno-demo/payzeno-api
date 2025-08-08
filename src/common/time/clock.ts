/**
 * Clock seam.
 *
 * ChargeExpiryPolicy (7d vs 30d), RefundPolicyService (REFUND_WINDOW_DAYS) and
 * DisputeDeadlineReminderJob are all date arithmetic against "now". Injecting the clock is
 * what makes those specs assertions instead of `jest.setSystemTime` gymnastics.
 *
 * Concretes: SystemClock (production), FixedClock (test/support/fixed.clock.ts).
 */
import type { IsoTimestamp } from '@payzeno/contracts';

export interface Clock {
  /** Milliseconds since epoch. */
  nowMs(): number;
  now(): Date;
  /** RFC 3339 UTC string — the only timestamp format that crosses a Payzeno boundary. */
  nowIso(): IsoTimestamp;
  plusSeconds(seconds: number): Date;
  plusDays(days: number): Date;
}

export const CLOCK = Symbol('CLOCK');

/** Shared implementations so SystemClock and FixedClock cannot drift in their arithmetic. */
export abstract class BaseClock implements Clock {
  abstract nowMs(): number;

  now(): Date {
    return new Date(this.nowMs());
  }

  nowIso(): IsoTimestamp {
    return new Date(this.nowMs()).toISOString();
  }

  plusSeconds(seconds: number): Date {
    return new Date(this.nowMs() + seconds * 1_000);
  }

  plusDays(days: number): Date {
    return new Date(this.nowMs() + days * 86_400_000);
  }
}

export function toIso(date: Date | null | undefined): IsoTimestamp | null {
  return date ? date.toISOString() : null;
}

/** Whole days between two instants, floored. Used by the refund and dispute windows. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Value alias so `Clock` can be used as a DI token as well as a type — `@Inject(Clock)` and
 * `moduleRef.get(Clock)` both work, and test/support/test-app.ts overrides it by that name.
 * Interface + const declaration merging: same symbol, one provider.
 */
export const Clock = CLOCK;
