/**
 * MerchantStatusStateMachine — domain-model.md §1 lifecycle, as a table.
 *
 *   pending_review ──approve──▶ active ──restrict──▶ restricted ──reinstate──▶ active
 *         │                       │                      │
 *         │                       ├──suspend──▶ suspended ┤
 *         └──reject──▶ rejected   │                      │
 *                                 └────────close─────────┴──▶ closed   (terminal)
 *
 * Note what `restricted` means and what it does not: it is "may charge, may NOT receive
 * payouts". It is set automatically by `RiskEvaluationService` when the trailing-30-day
 * dispute rate passes 100 bps, and it is reversible without a human deciding anything.
 * `suspended` is the human decision and it stops charging too.
 *
 * L5 — pure. It extends the same base as the five payment machines, so the table-driven
 * `state-machine.spec.ts` covers it with the others and `apply` throws from exactly one place
 * in the repo.
 */
import { Injectable } from '@nestjs/common';

import type { MerchantStatus } from '@payzeno/contracts';

import { InvalidMerchantTransitionException } from '../common/errors/state.exceptions';
import { StateMachine, type TransitionTable } from '../payments/state/state-machine';

export type MerchantStatusEvent = 'approve' | 'reject' | 'restrict' | 'reinstate' | 'suspend' | 'close';

@Injectable()
export class MerchantStatusStateMachine extends StateMachine<MerchantStatus, MerchantStatusEvent> {
  readonly entity = 'merchant';

  protected readonly transitions: TransitionTable<MerchantStatus, MerchantStatusEvent> = {
    pending_review: { approve: 'active', reject: 'rejected', close: 'closed' },
    active: { restrict: 'restricted', suspend: 'suspended', close: 'closed' },
    restricted: { reinstate: 'active', suspend: 'suspended', close: 'closed' },
    suspended: { reinstate: 'active', close: 'closed' },
    rejected: {},
    closed: {},
  };

  eventFor(from: MerchantStatus, to: MerchantStatus): MerchantStatusEvent {
    const event = (Object.keys(this.transitions[from] ?? {}) as MerchantStatusEvent[]).find(
      (candidate) => this.transitions[from]?.[candidate] === to,
    );

    if (!event) {
      throw new InvalidMerchantTransitionException(from, `→ ${to}`);
    }

    return event;
  }

  /**
   * Overridden so the merchant lifecycle raises its own subclass. Everything else — the
   * legality decision, the 409, the `allowed_events` detail — still comes from the base.
   */
  override apply(from: MerchantStatus, event: MerchantStatusEvent): MerchantStatus {
    const next = this.transitions[from]?.[event];
    if (next === undefined) {
      throw new InvalidMerchantTransitionException(from, event);
    }
    return next;
  }

  /** True for the two statuses that stop money moving in either direction. */
  isFrozen(status: MerchantStatus): boolean {
    return status === 'suspended' || status === 'closed' || status === 'rejected';
  }
}
