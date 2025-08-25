/**
 * Charge FSM — domain-model.md §3.
 *
 * ```
 * pending ──authorize──▶ authorized ──capture──▶ captured ──settle──▶ settled  (terminal)
 *    │                       │                       │
 *    │                       ├──expire──▶ expired    │
 *    │                       └──void────▶ voided     │
 *    └──decline──▶ failed                            └──reverse──▶ reversed
 * ```
 *
 * `refunded` and `partially_refunded` are NOT states. They are computed from
 * `refunded_amount_minor` vs `captured_amount_minor` (`ChargeEntity.refundState`). A generated
 * `refunded` status is the single most common wrong answer here.
 *
 * `captured → settled` is the only transition on this entity that a bus event drives, and the
 * only driver is `settlement.completed` arriving at `LedgerEventsConsumer`.
 *
 * Cold file. Month 1, unchanged since.
 */

import { Injectable } from '@nestjs/common';
import type { ChargeStatus } from '@payzeno/contracts';

import { StateMachine, type TransitionTable } from './state-machine';

export type ChargeEvent = 'authorize' | 'capture' | 'settle' | 'decline' | 'void' | 'expire' | 'reverse';

const TRANSITIONS: TransitionTable<ChargeStatus, ChargeEvent> = {
  pending: {
    authorize: 'authorized',
    decline: 'failed',
  },
  authorized: {
    capture: 'captured',
    void: 'voided',
    expire: 'expired',
  },
  captured: {
    settle: 'settled',
    reverse: 'reversed',
  },
  settled: {},
  failed: {},
  voided: {},
  expired: {},
  reversed: {},
};

/**
 * MCCs the schemes grant 30-day authorisation validity: travel (3000-3999), lodging (7011)
 * and car rental (7512). Exactly the set eligible for `capture_at_settlement` — a flat 7-day
 * expiry would void the holds that feature exists to capture. See `ChargeExpiryPolicy`.
 */
export const DEFERRED_SETTLEMENT_MCCS: ReadonlySet<string> = new Set(['7011', '7512']);

@Injectable()
export class ChargeStateMachine extends StateMachine<ChargeStatus, ChargeEvent> {
  readonly entity = 'charge';
  protected readonly transitions = TRANSITIONS;
  readonly terminalStates: ReadonlySet<ChargeStatus> = new Set<ChargeStatus>([
    'settled',
    'failed',
    'voided',
    'expired',
    'reversed',
  ]);

  /** A refund may only be created against these. An `authorized` charge takes a void instead. */
  isRefundable(status: ChargeStatus): boolean {
    return status === 'captured' || status === 'settled';
  }

  /** The auth hold is live and money is not yet moved. */
  holdsAuthorization(status: ChargeStatus): boolean {
    return status === 'authorized';
  }
}
