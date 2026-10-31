/**
 * The wire shapes for payzeno-api → payzeno-ledger (api-surface.md §10/§11), plus the one
 * helper that builds the ledger's deterministic idempotency keys.
 *
 * Everything the ledger returns is a `@payzeno/contracts` type; only the *query* shapes live
 * here, because a query string is not a contract type.
 */

import type {
  Acquirer,
  Balance,
  ChargeId,
  CurrencyCode,
  IsoDate,
  IsoTimestamp,
  LedgerPurpose,
  LedgerReferenceType,
  MerchantId,
  MinorUnits,
  PayoutMethod,
  PayoutStatus,
  ReconciliationItemStatus,
  SettlementBatchStatus,
  TimeseriesInterval,
} from '@payzeno/contracts';

export interface BalanceQuery {
  currency?: CurrencyCode;
  as_of?: IsoTimestamp;
  livemode?: boolean;
}

/**
 * `GET /internal/v1/balances/{merchant_id}` without `?currency=` (RFC platform-v2 §7): one
 * balance per currency the merchant has posted in, ordered by code. Also `GET /v1/balance`'s
 * answer when no currency is asked for.
 */
export interface BalanceList {
  data: Balance[];
}

export interface BalanceHistoryQuery {
  currency: CurrencyCode;
  from: IsoTimestamp;
  to: IsoTimestamp;
  interval: TimeseriesInterval;
}

export interface TransactionListQuery {
  merchant_id?: MerchantId;
  reference_type?: LedgerReferenceType;
  reference_id?: string;
  purpose?: LedgerPurpose;
  cursor?: string;
  limit?: number;
}

export interface SettlementBatchListQuery {
  merchant_id?: MerchantId;
  currency?: CurrencyCode;
  status?: SettlementBatchStatus;
  acquirer?: Acquirer;
  cursor?: string;
  limit?: number;
}

export interface SettlementItemListQuery {
  /** REQUIRED on this route. A SettlementBatch has no merchant_id, so scoping happens here. */
  merchant_id: MerchantId;
  status?: ReconciliationItemStatus;
  line_type?: string;
  cursor?: string;
  limit?: number;
}

export interface PayoutListQuery {
  merchant_id?: MerchantId;
  status?: PayoutStatus;
  currency?: CurrencyCode;
  cursor?: string;
  limit?: number;
}

export interface CreatePayoutBody {
  merchant_id: MerchantId;
  amount_minor?: MinorUnits;
  currency: CurrencyCode;
  bank_account_id?: string;
  method?: PayoutMethod;
  statement_descriptor?: string;
}

export interface RetryItemBody {
  requested_by?: string;
  reason?: string;
}

export interface ReverseTransactionBody {
  reason: string;
  idempotency_key: string;
}

export interface BootstrapAccountsBody {
  merchant_id: MerchantId;
  currency: CurrencyCode;
  livemode: boolean;
}

/** Convenience shape for the read-through service's capture posting. */
export interface CapturePostingCommand {
  chargeId: ChargeId;
  merchantId: MerchantId;
  currency: CurrencyCode;
  livemode: boolean;
  amountMinor: MinorUnits;
  platformFeeBps: number;
  platformFeeFixedMinor: MinorUnits;
  reserveBps: number;
}

export interface RefundPostingCommand {
  refundId: string;
  chargeId: ChargeId;
  merchantId: MerchantId;
  currency: CurrencyCode;
  livemode: boolean;
  amountMinor: MinorUnits;
}

export interface DisputePostingCommand {
  disputeId: string;
  chargeId: ChargeId;
  merchantId: MerchantId;
  currency: CurrencyCode;
  livemode: boolean;
  amountMinor: MinorUnits;
  feeMinor: MinorUnits;
}

export interface AuthReleaseCommand {
  chargeId: ChargeId;
  merchantId: MerchantId;
  currency: CurrencyCode;
  livemode: boolean;
  amountMinor: MinorUnits;
}

export interface StagedInvoiceLine {
  description: string;
  quantity: number;
  unit_amount_minor: MinorUnits;
  amount_minor: MinorUnits;
}

export interface StagedInvoiceLinesResponse {
  lines: StagedInvoiceLine[];
}

export interface MerchantSettlementItemsPage {
  data: unknown[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface SettlementFundingBody {
  bank_reference: string;
  amount_minor: MinorUnits;
  value_date: IsoDate;
}

/**
 * `<purpose>:<scope_id>:<subject_id>` — domain-model.md §0.3(b). Deterministic, derived from
 * the business fact, never from an attempt counter or a clock. That determinism is what makes
 * a retry of `postTransaction` safe by contract (api-surface.md §11) and it is the same
 * function `app/domain/idempotency.py::ledger_key` implements on the Python side.
 *
 * Do not "improve" this by appending an attempt number. The uniqueness of this key is the only
 * thing standing between Payzeno and a duplicate settlement.
 */
export function ledgerKey(
  purpose: LedgerPurpose | 'capture' | 'auth' | 'authrelease',
  scopeId: string,
  subjectId = '',
): string {
  return `${purpose}:${scopeId}:${subjectId}`;
}
