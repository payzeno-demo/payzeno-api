/**
 * OnboardingStateMachine — RFC platform-v2 §3, as a table.
 *
 *   collecting ──submit──▶ submitted ──approve──▶ approved   (terminal; merchant → active)
 *                              │  ▲
 *                 request_info │  │ submit
 *                              ▼  │
 *                          needs_info ──reject──▶ rejected   (terminal; merchant → rejected)
 *                              ▲
 *   submitted ──reject─────────┴─────────────────▶ rejected
 *
 * A merchant moves it with `submit`; staff move it with the three decisions. The merchant may
 * edit its profile and upload documents only in the two states it owns (`collecting`,
 * `needs_info`) — editing what a reviewer is looking at, while they look at it, is how an
 * approval ends up attached to a different passport.
 *
 * L5 — pure. The service decides what an approval does to `merchant.status`; this decides only
 * whether the transition is legal.
 */
import { Injectable } from '@nestjs/common';

import type { OnboardingState } from '@payzeno/contracts';

import { InvalidStateTransitionException } from '../../common/errors/state.exceptions';
import { StateMachine, type TransitionTable } from '../../payments/state/state-machine';

export type OnboardingEvent = 'submit' | 'approve' | 'reject' | 'request_info';

/** The staff decisions, in route form (`POST /v1/admin/merchants/:id/onboarding/<decision>`). */
export type OnboardingDecision = 'approve' | 'reject' | 'request-info';

export const DECISION_EVENTS: Readonly<Record<OnboardingDecision, OnboardingEvent>> = {
  approve: 'approve',
  reject: 'reject',
  'request-info': 'request_info',
};

@Injectable()
export class OnboardingStateMachine extends StateMachine<OnboardingState, OnboardingEvent> {
  readonly entity = 'onboarding';

  protected readonly transitions: TransitionTable<OnboardingState, OnboardingEvent> = {
    collecting: { submit: 'submitted' },
    submitted: { approve: 'approved', reject: 'rejected', request_info: 'needs_info' },
    needs_info: { submit: 'submitted', reject: 'rejected' },
    approved: {},
    rejected: {},
  };

  readonly terminalStates: ReadonlySet<OnboardingState> = new Set<OnboardingState>(['approved', 'rejected']);

  /** May the merchant change its profile or upload a document right now? */
  isEditable(state: OnboardingState): boolean {
    return state === 'collecting' || state === 'needs_info';
  }

  /**
   * 409 `invalid_state` for an edit while a reviewer has it (or after a decision). Not a
   * transition, but the same refusal the console already renders for one.
   */
  assertEditable(state: OnboardingState): void {
    if (!this.isEditable(state)) {
      throw new InvalidStateTransitionException(this.entity, state, 'edit', this.allowedEvents(state));
    }
  }
}
