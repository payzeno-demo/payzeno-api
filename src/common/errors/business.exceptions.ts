/**
 * Business-rule refusals. Each of these is a deliberate product decision, not a fault, and
 * each maps to a row of api-surface.md §1.4. None of them burn the error budget.
 */
import type { CurrencyCode, ErrorCode, MinorUnits } from '@payzeno/contracts';

import { ApiException } from './api.exception';

/** RefundPolicyService — the FOR UPDATE re-read of `charge.refunded_amount_minor`. */
export class RefundAmountExceededException extends ApiException {
  readonly code: ErrorCode = 'refund_amount_exceeded';
  readonly httpStatus = 422;

  constructor(
    readonly chargeId: string,
    requestedMinor: MinorUnits,
    refundableMinor: MinorUnits,
    currency: CurrencyCode,
  ) {
    super(
      `Refund of ${requestedMinor} exceeds the ${refundableMinor} still refundable on ${chargeId}`,
      {
        charge_id: chargeId,
        requested_minor: requestedMinor,
        refundable_minor: refundableMinor,
        currency,
      },
    );
  }
}

/** RefundPolicyService — REFUND_WINDOW_DAYS past `charge.captured_at`. */
export class RefundWindowClosedException extends ApiException {
  readonly code: ErrorCode = 'refund_window_closed';
  readonly httpStatus = 422;

  constructor(chargeId: string, windowDays: number) {
    super(`Charge ${chargeId} is past the ${windowDays}-day refund window`, {
      charge_id: chargeId,
      window_days: windowDays,
    });
  }
}

/** DisputesService.openFromWebhook — 23505 on `uq_dispute_charge_open`. */
export class DuplicateDisputeException extends ApiException {
  readonly code: ErrorCode = 'duplicate_dispute';
  readonly httpStatus = 409;

  constructor(chargeId: string) {
    super(`Charge ${chargeId} already has an open dispute`, { charge_id: chargeId });
  }
}

/** DisputesService.submitEvidence past `evidence_due_by`. */
export class DisputeWindowClosedException extends ApiException {
  readonly code: ErrorCode = 'dispute_window_closed';
  readonly httpStatus = 422;

  constructor(disputeId: string, dueBy: string | null) {
    super(`Evidence for dispute ${disputeId} was due by ${dueBy ?? 'an earlier date'}`, {
      dispute_id: disputeId,
      evidence_due_by: dueBy,
    });
  }
}

/**
 * 403. Two throw sites: MerchantScopeGuard (status `suspended` — may not charge) and
 * PayoutsService.create (status `restricted` — may charge, may not be paid out).
 */
export class MerchantRestrictedException extends ApiException {
  readonly code: ErrorCode = 'merchant_restricted';
  readonly httpStatus = 403;

  constructor(
    readonly merchantId: string,
    status: string,
    action: string,
  ) {
    super(`Merchant is '${status}' and may not ${action}`, {
      merchant_id: merchantId,
      status,
      action,
    });
  }
}

/** 429. RateLimitGuard (pre-auth buckets) and RateLimitInterceptor (per-merchant refinement). */
export class RateLimitedException extends ApiException {
  readonly code: ErrorCode = 'rate_limited';
  readonly httpStatus = 429;

  constructor(
    readonly retryAfterSec: number,
    readonly limit: number,
  ) {
    super('Too many requests', { retry_after: retryAfterSec, limit });
  }
}
