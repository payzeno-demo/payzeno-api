/**
 * PaymentIntent FSM — domain-model.md §2.
 *
 * ```
 * requires_payment_method ──attach──▶ requires_confirmation ──confirm──▶ processing
 *         ▲                                                              │   ▲
 *         │ decline (retryable)                                          │   │ complete_action
 *         └──────────────────────────────────────────────────────────────┤   │
 *                                                     requires_action ◀───┴───┘
 *                                                                            ├─▶ requires_capture
 *                                                                            ├─▶ succeeded
 *                                                                            └─▶ failed
 * any non-terminal ──cancel──▶ canceled
 * ```
 *
 * `requires_action` is not optional: under PSD2 a EUR or GBP e-commerce authorisation without
 * SCA or a documented exemption is declined by the issuer, and three of the five supported
 * currencies are in scope.
 *
 * Cold file. Written in month 1, touched by migration 28 only (`requires_action` was added to
 * the pg enum then, but the table below always had it).
 */

import { Injectable } from '@nestjs/common';
import type { PaymentIntentStatus } from '@payzeno/contracts';

import { StateMachine, type TransitionTable } from './state-machine';

export type PaymentIntentEvent =
  | 'attach_payment_method'
  | 'confirm'
  | 'require_action'
  | 'complete_action'
  | 'authorize'
  | 'capture'
  | 'decline'
  | 'fail'
  | 'cancel';

const TRANSITIONS: TransitionTable<PaymentIntentStatus, PaymentIntentEvent> = {
  requires_payment_method: {
    attach_payment_method: 'requires_confirmation',
    cancel: 'canceled',
    fail: 'failed',
  },
  requires_confirmation: {
    confirm: 'processing',
    attach_payment_method: 'requires_confirmation',
    cancel: 'canceled',
  },
  processing: {
    require_action: 'requires_action',
    authorize: 'requires_capture',
    capture: 'succeeded',
    // A retryable decline sends the buyer back for another payment method rather than
    // terminating the intent. A non-retryable one takes `fail`.
    decline: 'requires_payment_method',
    fail: 'failed',
    cancel: 'canceled',
  },
  requires_action: {
    complete_action: 'processing',
    fail: 'failed',
    cancel: 'canceled',
  },
  requires_capture: {
    capture: 'succeeded',
    cancel: 'canceled',
    fail: 'failed',
  },
  succeeded: {},
  failed: {},
  canceled: {},
};

@Injectable()
export class PaymentIntentStateMachine extends StateMachine<PaymentIntentStatus, PaymentIntentEvent> {
  readonly entity = 'payment_intent';
  protected readonly transitions = TRANSITIONS;
  readonly terminalStates: ReadonlySet<PaymentIntentStatus> = new Set<PaymentIntentStatus>([
    'succeeded',
    'failed',
    'canceled',
  ]);

  /**
   * `capture_method` decides where a successful authorisation lands: `automatic` captures in
   * the same call and goes straight to `succeeded`, `manual` parks at `requires_capture` until
   * the merchant calls `POST /v1/payment_intents/:id/capture`.
   */
  eventForAuthorization(captureMethod: 'automatic' | 'manual'): PaymentIntentEvent {
    return captureMethod === 'automatic' ? 'capture' : 'authorize';
  }

  /** True while the intent may still produce another Charge. */
  acceptsNewCharge(status: PaymentIntentStatus): boolean {
    return status === 'requires_confirmation' || status === 'requires_payment_method' || status === 'processing';
  }
}
