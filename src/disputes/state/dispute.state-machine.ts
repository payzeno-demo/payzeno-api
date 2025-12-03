/**
 * DisputeStateMachine — domain-model.md §5.
 *
 * Two lifecycles in one table. The chargeback lifecycle
 * (`needs_response → under_review → won|lost`) moves money; the early-warning lifecycle
 * (`warning_needs_response → warning_closed`) never does — RDR/Ethoca alerts arrive as
 * disputes because the acquirer sends them down the same webhook, and the console shows them
 * as disputes, but no `chargeback_liability` leg is ever posted for them.
 *
 * TODO(PAY-1907): the warning_* branch has no product surface. The transitions exist so the
 * network codes have somewhere to land when it gets one.
 */

import { Injectable } from '@nestjs/common';
import type { DisputeStatus } from '@payzeno/contracts';

import { StateMachine, type TransitionTable } from '../../payments/state/state-machine';

export type DisputeEvent = 'submit_evidence' | 'accept' | 'expire' | 'win' | 'lose' | 'close';

const TRANSITIONS: TransitionTable<DisputeStatus, DisputeEvent> = {
  needs_response: {
    submit_evidence: 'under_review',
    // The merchant concedes. @StaffOnly('risk') on POST /v1/disputes/:id/accept.
    accept: 'lost',
    // DisputeDeadlineReminderJob, daily at 07:00, off ix_dispute_evidence_due.
    expire: 'lost',
  },
  under_review: {
    win: 'won',
    lose: 'lost',
  },
  warning_needs_response: {
    close: 'warning_closed',
  },
  won: {},
  lost: {},
  warning_closed: {},
};

@Injectable()
export class DisputeStateMachine extends StateMachine<DisputeStatus, DisputeEvent> {
  readonly entity = 'dispute';
  protected readonly transitions = TRANSITIONS;
  readonly terminalStates: ReadonlySet<DisputeStatus> = new Set<DisputeStatus>([
    'won',
    'lost',
    'warning_closed',
  ]);

  /** Early-warning alerts: shown, counted, never posted to the ledger. */
  isWarning(status: DisputeStatus): boolean {
    return status === 'warning_needs_response' || status === 'warning_closed';
  }

  /** Only the liability leg reverses on a win; the chargeback fee is retained either way. */
  reversesLiability(outcome: DisputeStatus): boolean {
    return outcome === 'won';
  }

  /**
   * `liability_shifted && reason === 'fraudulent'` means the issuer already ate the loss under
   * 3DS. The dispute is still recorded — the network sends it — but asking the merchant for
   * evidence is asking them to defend a case they cannot lose.
   */
}
