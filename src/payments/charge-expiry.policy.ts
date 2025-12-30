/**
 * Authorisation validity. L5 — pure date arithmetic over an injected `Clock`, no I/O.
 *
 * Authorisation validity is not flat (domain-model.md §3). The schemes grant 30 days to the
 * deferred-settlement MCCs — travel 3000-3999, lodging 7011, car rental 7512 — precisely
 * because capture happens at checkout or return rather than at booking. Those are exactly the
 * MCCs eligible for `capture_at_settlement`, so a flat 7-day expiry would void the holds that
 * feature exists to capture, and arc INC's blast radius would not exist because there would
 * be nothing left to capture at settlement.
 *
 * `ChargeExpiryJob` (hourly) reads `ix_charge_authorization_expires` and drives
 * `authorized → expired`, posting `auth_release` through the ledger.
 */

import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../common/time/clock';

export const STANDARD_AUTH_WINDOW_DAYS = 7;
export const DEFERRED_AUTH_WINDOW_DAYS = 30;

/** Discrete MCCs outside the 3000-3999 travel band that carry the extended window. */
const DEFERRED_MCCS: ReadonlySet<string> = new Set(['7011', '7512']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class ChargeExpiryPolicy {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /** True when `mcc` is in the deferred-settlement set. */
  isDeferredSettlementMcc(mcc: string): boolean {
    if (DEFERRED_MCCS.has(mcc)) {
      return true;
    }
    const numeric = Number.parseInt(mcc, 10);
    return Number.isInteger(numeric) && numeric >= 3000 && numeric <= 3999;
  }

  windowDays(mcc: string): number {
    return this.isDeferredSettlementMcc(mcc) ? DEFERRED_AUTH_WINDOW_DAYS : STANDARD_AUTH_WINDOW_DAYS;
  }

  /** `authorized_at + window`. Written to `charge.authorization_expires_at` at authorisation. */
  expiresAt(mcc: string, authorizedAt: Date = this.clock.now()): Date {
    return new Date(authorizedAt.getTime() + this.windowDays(mcc) * MS_PER_DAY);
  }

  supportsCaptureAtSettlement(mcc: string): boolean {
    return this.isDeferredSettlementMcc(mcc);
  }

}
