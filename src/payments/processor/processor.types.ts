/**
 * The acquirer-facing request/response shapes. Verbatim from interfaces.md §2.5 — these are
 * payzeno-api-internal types and deliberately do NOT live in `@payzeno/contracts`, because no
 * other repo speaks them.
 *
 * `DeclineCodeMapper` is folded in here (blueprint §5): it is the single place a raw acquirer
 * decline string becomes a `DeclineCode` and then a `CardDeclinedException` subclass.
 */

import type {
  Acquirer,
  CardSummary,
  CaptureMethod,
  ChargeId,
  CurrencyCode,
  DeclineCode,
  IsoTimestamp,
  MerchantId,
  MinorUnits,
  PaymentMethodToken,
  RefundReason,
} from '@payzeno/contracts';

export interface ThreeDSecureRequest {
  returnUrl: string;
  challengePreference: 'auto' | 'force';
}

export interface ThreeDSecureResult {
  version: string;
  authenticationFlow: 'frictionless' | 'challenge';
  result: 'authenticated' | 'attempted' | 'failed' | 'unavailable';
  eci: string;
  liabilityShifted: boolean;
}

export interface AuthorizeRequest {
  chargeId: ChargeId;
  merchantId: MerchantId;
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  paymentMethodToken: PaymentMethodToken;
  captureMethod: CaptureMethod;
  statementDescriptor: string | null;
  threeDSecure: ThreeDSecureRequest | null;
  idempotencyKey: string;
}

export interface AuthorizeResult {
  approved: boolean;
  /**
   * True while the issuer is waiting on a 3-D Secure challenge: nothing is authorised or
   * declined yet. `ProcessorAdapter.getAuthorization` reads the outcome back afterwards.
   */
  pendingAuthentication: boolean;
  /** Where to send the cardholder for that challenge, when the acquirer hosts the page. */
  challengeUrl: string | null;
  networkTransactionId: string | null;
  authorizationCode: string | null;
  processorReference: string;
  declineCode: DeclineCode | null;
  riskScore: number;
  card: CardSummary;
  threeDSecure: ThreeDSecureResult | null;
  raw: Record<string, unknown>;
}

export interface CaptureRequest {
  networkTransactionId: string;
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  idempotencyKey: string;
}

export interface CaptureResult {
  captured: boolean;
  processorReference: string;
  capturedAmountMinor: MinorUnits;
  capturedAt: IsoTimestamp;
}

export interface VoidRequest {
  networkTransactionId: string;
  idempotencyKey: string;
}

export interface VoidResult {
  voided: boolean;
  processorReference: string;
}

export interface ProcessorRefundRequest {
  networkTransactionId: string;
  amountMinor: MinorUnits;
  currency: CurrencyCode;
  reason: RefundReason;
  idempotencyKey: string;
}

export interface ProcessorRefundResult {
  refunded: boolean;
  processorReference: string;
  failureReason: string | null;
}

export type ProcessorWebhookKind =
  | 'dispute_opened'
  | 'dispute_closed'
  | 'capture_settled'
  | 'refund_settled'
  | 'chargeback_reversed';

export interface ProcessorWebhookEvent {
  acquirer: Acquirer;
  kind: ProcessorWebhookKind;
  networkTransactionId: string;
  occurredAt: IsoTimestamp;
  raw: Record<string, unknown>;
}

/**
 * Acquirer decline strings → the `DeclineCode` vocabulary in types.ts. Worldflow and Nordpay
 * disagree on spelling for four of the ten; both spellings are listed rather than normalised
 * upstream, because "normalise in the adapter" is how one acquirer's `05` silently became
 * `processing_error` for six weeks in month 3.
 */
const DECLINE_CODE_BY_RAW: Readonly<Record<string, DeclineCode>> = {
  '05': 'do_not_honor',
  do_not_honor: 'do_not_honor',
  donothonour: 'do_not_honor',
  '51': 'insufficient_funds',
  insufficient_funds: 'insufficient_funds',
  nsf: 'insufficient_funds',
  '41': 'lost_card',
  lost_card: 'lost_card',
  '43': 'stolen_card',
  stolen_card: 'stolen_card',
  '54': 'expired_card',
  expired_card: 'expired_card',
  '82': 'incorrect_cvc',
  cvv_failure: 'incorrect_cvc',
  incorrect_cvc: 'incorrect_cvc',
  '96': 'processing_error',
  processing_error: 'processing_error',
  '91': 'issuer_unavailable',
  issuer_unavailable: 'issuer_unavailable',
  issuer_down: 'issuer_unavailable',
  '65': 'velocity_exceeded',
  velocity_exceeded: 'velocity_exceeded',
  '59': 'fraud_suspected',
  fraud_suspected: 'fraud_suspected',
  suspected_fraud: 'fraud_suspected',
};

export function mapDeclineCode(raw: string | null | undefined): DeclineCode {
  if (!raw) {
    return 'processing_error';
  }
  return DECLINE_CODE_BY_RAW[raw.trim().toLowerCase()] ?? 'processing_error';
}

/**
 * Re-exported, not reimplemented. The retryable set is domain-model.md §2 and it belongs next
 * to the exception it decides the shape of (`src/common/errors/card.exceptions.ts`). There were
 * two copies of this predicate for about a week and they were already drifting — one of them
 * had `do_not_honor` in the set, which is exactly the code you must not retry.
 */
export { isRetryableDecline, RETRYABLE_DECLINE_CODES } from '../../common/errors/card.exceptions';
