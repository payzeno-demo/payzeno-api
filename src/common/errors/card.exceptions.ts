/**
 * 402. Issuer declines.
 *
 * All three are thrown from `ChargeAuthorizationService` via the decline-code mapper in
 * src/payments/processor/processor.types.ts. `details.decline_code` is on the wire contract
 * (api-surface.md §1.4) — the console renders a different recovery hint per code, so the code
 * matters more than the class does.
 */
import type { DeclineCode, ErrorCode } from '@payzeno/contracts';

import { ApiException } from './api.exception';

export class CardDeclinedException extends ApiException {
  readonly code: ErrorCode = 'card_declined';
  readonly httpStatus = 402;

  constructor(
    readonly declineCode: DeclineCode,
    message = 'The card was declined',
    details?: Record<string, unknown>,
  ) {
    super(message, { ...details, decline_code: declineCode });
  }
}

export class InsufficientFundsException extends CardDeclinedException {
  override readonly code: ErrorCode = 'insufficient_funds';

  constructor(details?: Record<string, unknown>) {
    super('insufficient_funds', 'The card has insufficient funds', details);
  }
}

export class ExpiredCardException extends CardDeclinedException {
  override readonly code: ErrorCode = 'expired_card';

  constructor(details?: Record<string, unknown>) {
    super('expired_card', 'The card has expired', details);
  }
}

/**
 * Decline codes that a retry with the same card can plausibly clear. Consumed by
 * PaymentIntentStateMachine to decide `failed` (terminal) vs back to
 * `requires_payment_method` (retryable) — domain-model.md §2.
 */
export const RETRYABLE_DECLINE_CODES: ReadonlySet<DeclineCode> = new Set<DeclineCode>([
  'processing_error',
  'issuer_unavailable',
  'velocity_exceeded',
]);

export function isRetryableDecline(code: DeclineCode): boolean {
  return RETRYABLE_DECLINE_CODES.has(code);
}
