/**
 * 502 and the ledger passthrough.
 *
 * The distinction that matters, and the one review keeps having to restate:
 *
 *   LedgerUnavailableException  transport only — connect timeout, read timeout, ECONNRESET,
 *                               or a 5xx with no parseable ApiError body.
 *   LedgerRejectedException     ANY non-2xx from payzeno-ledger that carries a parseable
 *                               ApiError body. Code, status and details pass through
 *                               VERBATIM.
 *
 * Collapsing the second into the first is what makes `settlement_locked` — the *normal*
 * outcome of racing a reconciliation sweep after PAY-2043 — look like an outage. See
 * interfaces.md §2.4 and the-incident.md §3.
 */
import type { ErrorCode } from '@payzeno/contracts';

import { ApiException } from './api.exception';

export class UpstreamException extends ApiException {
  readonly code: ErrorCode = 'internal_error';
  readonly httpStatus: number = 502;

  constructor(
    readonly upstream: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message, { ...details, upstream });
  }
}

/** AcquirerHttpClient on transport failure, and CircuitBreakerRegistry on an open circuit. */
export class ProcessorUnavailableException extends UpstreamException {
  override readonly code: ErrorCode = 'processor_unavailable';

  constructor(acquirer: string, cause?: string) {
    super(acquirer, `Acquirer '${acquirer}' is unavailable`, { cause: cause ?? null });
  }
}

/** Transport failure talking to payzeno-ledger. Never a business refusal. */
export class LedgerUnavailableException extends UpstreamException {
  override readonly code: ErrorCode = 'internal_error';

  constructor(operation: string, cause?: string) {
    super('payzeno-ledger', `payzeno-ledger did not respond to ${operation}`, {
      operation,
      cause: cause ?? null,
    });
  }
}

/**
 * The passthrough branch. `httpStatus` and `code` are the LEDGER'S, not 502 — a
 * `409 settlement_locked` must reach the console as a 409 or `useRetrySettlementItem()`
 * cannot show "already settling" and refetch.
 */
export class LedgerRejectedException extends UpstreamException {
  override readonly code: ErrorCode;
  override readonly httpStatus: number;

  constructor(
    code: ErrorCode,
    httpStatus: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super('payzeno-ledger', message, details);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** BillingLegacyClient — opossum breaker trip, or a 5xx from hlegacy's Spring app. */
export class LegacyBillingUnavailableException extends UpstreamException {
  override readonly code: ErrorCode = 'legacy_upstream_unavailable';

  constructor(operation: string, breakerOpen = false) {
    super('payzeno-billing-legacy', `Legacy billing is unavailable for ${operation}`, {
      operation,
      breaker_open: breakerOpen,
    });
  }
}
