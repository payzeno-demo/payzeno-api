/**
 * RefundStateMachine — domain-model.md §4.
 *
 * Four statuses, three transitions, all of them out of `pending`. The interesting rule is the
 * one that is NOT here: there is no `failed → pending` retry edge. A retry is a new `refund`
 * row, because the failed row's `processor_reference` is already spent against
 * `uq_refund_processor_reference` and the acquirer will reject a second submission under the
 * same reference.
 *
 * Cold file. Written in month 2 with the rest of the refunds module and untouched since.
 */

import { Injectable } from '@nestjs/common';
import type { RefundStatus } from '@payzeno/contracts';

import { StateMachine, type TransitionTable } from '../../payments/state/state-machine';

export type RefundEvent = 'succeed' | 'fail' | 'cancel';

const TRANSITIONS: TransitionTable<RefundStatus, RefundEvent> = {
  pending: {
    succeed: 'succeeded',
    fail: 'failed',
    // Only legal while the underlying charge is unsettled — RefundsService checks that
    // before it calls apply(), because the FSM has no view of the charge.
    cancel: 'canceled',
  },
  succeeded: {},
  failed: {},
  canceled: {},
};

@Injectable()
export class RefundStateMachine extends StateMachine<RefundStatus, RefundEvent> {
  readonly entity = 'refund';
  protected readonly transitions = TRANSITIONS;
  readonly terminalStates: ReadonlySet<RefundStatus> = new Set<RefundStatus>([
    'succeeded',
    'failed',
    'canceled',
  ]);

  /**
   * The acquirer webhook (`refund_settled`) and the synchronous acquirer response both land
   * here. `ProcessorWebhookService` uses it so a redelivered webhook for an already-succeeded
   * refund is a no-op rather than an InvalidStateTransitionException in the logs.
   */
  isSettlementNoop(current: RefundStatus): boolean {
    return current === 'succeeded';
  }

  /** A refund that never reached the acquirer still owes the merchant their money back. */
  releasesFunds(next: RefundStatus): boolean {
    return next === 'failed' || next === 'canceled';
  }
}
