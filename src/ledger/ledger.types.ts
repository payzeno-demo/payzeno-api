/**
 * The wire shapes for payzeno-api → payzeno-ledger (api-surface.md §10/§11), plus the one
 * helper that builds the ledger's deterministic idempotency keys.
 *
 * Everything the ledger returns is a `@payzeno/contracts` type; only the *query* shapes live
 * here, because a query string is not a contract type.
 */

import type {
  Acquirer,
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
