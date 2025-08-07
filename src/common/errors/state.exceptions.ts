/**
 * 409 invalid_state.
 *
 * `InvalidStateTransitionException` has exactly one throw site — `StateMachine.apply` in
 * src/payments/state/state-machine.ts — and all six machines reach it. That is deliberate:
 * one place decides that a transition is illegal, six tables describe which ones are.
 */
import type { ErrorCode } from '@payzeno/contracts';

import { ApiException } from './api.exception';

export class InvalidStateTransitionException extends ApiException {
  readonly code: ErrorCode = 'invalid_state';
  readonly httpStatus = 409;

  /**
   * The fourth argument is either a message (the subclasses use that form) or the list of
   * events that WOULD have been legal from `from` — `StateMachine.apply` passes
   * `allowedEvents(from)` so the 409 body can tell the console what to offer instead of
   * making it guess. One constructor, because two would mean two ways to raise the repo's
   * single invalid-state exception.
   */
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly event: string,
    messageOrAllowed?: string | readonly string[],
  ) {
    const allowed = Array.isArray(messageOrAllowed) ? (messageOrAllowed as readonly string[]) : null;
    const message = typeof messageOrAllowed === 'string' ? messageOrAllowed : undefined;

    super(message ?? `Cannot '${event}' a ${entity} in state '${from}'`, {
      entity,
      from_state: from,
      event,
      allowed_events: allowed ? allowed.join(',') : null,
    });

    this.allowedEvents = allowed ?? [];
  }

  /** Empty when the thrower supplied a message instead. */
  readonly allowedEvents: readonly string[];
}

/** MerchantStatusStateMachine.apply — see domain-model.md §1 lifecycle diagram. */
export class InvalidMerchantTransitionException extends InvalidStateTransitionException {
  constructor(from: string, event: string) {
    super(
      'merchant',
      from,
      event,
      `Merchant status '${from}' does not allow '${event}'`,
    );
  }
}

/**
 * ChargeCaptureService.captureCharge. Separate from the generic class because the console
 * shows a different remediation ("this charge was voided / already captured / expired") and
 * because capture is the single most-supported failure in the product.
 */
export class ChargeNotCapturableException extends InvalidStateTransitionException {
  constructor(
    readonly chargeId: string,
    from: string,
  ) {
    super('charge', from, 'capture', `Charge ${chargeId} is '${from}' and cannot be captured`);
  }
}
