/**
 * payzeno-api → payzeno-ledger. Fourteen methods, one per row of api-surface.md §11.
 *
 * This file grows one method per ledger route and has done all year; it is the densest
 * cross-repo `HTTP_CALLS` surface in the repo.
 *
 * ### Error translation — the rule this class exists to enforce
 *
 * **Any** non-2xx carrying a parseable `ApiError` body becomes `LedgerRejectedException`,
 * with the ledger's `code`, `httpStatus` and `details` passed through **verbatim**.
 * `LedgerUnavailableException` is reserved for transport failure — connect timeout, read
 * timeout, connection reset, and 5xx with no parseable body.
 *
 * Collapsing the first case into the second is the mistake this comment exists to prevent: it
 * is what gives `settlement_locked`, `duplicate_settlement`, `batch_not_reconcilable`,
 * `payout_blocked`, `account_frozen` and `ledger_imbalance` a route to the merchant instead of
 * a generic 502. After PAY-2043, `409 settlement_locked` is the *normal* outcome of racing a
 * sweep and the console renders it as "already settling" — as a 502 it would page someone.
 *
 * Timeouts: connect 2s, read 10s, 30s for `listSettlementItems`. Retries: 2, idempotent verbs
 * only, predicate `502|503|504|connect-timeout|read-timeout|ECONNRESET`.
 */

import { Injectable } from '@nestjs/common';
import type {
  Account,
  Balance,
  BalanceHistoryResponse,
  BootstrapAccountsResponse,
  CurrencyCode,
  LedgerTransaction,
  MerchantId,
  Paginated,
  Payout,
  PayoutId,
  PostTransactionRequest,
  ReconciliationItem,
  SettlementBatch,
  SettlementBatchId,
} from '@payzeno/contracts';

import { BaseHttpClient, type ApiClientOptions, type RequestSpec, type UpstreamFailure } from '../api/client';
import type { RetryPolicy } from '../api/retry.policy';
import type { HttpTransport, TransportError } from '../api/transport.interface';
import { LedgerRejectedException, LedgerUnavailableException } from '../common/errors/upstream.exceptions';
import type { PayzenoLogger } from '../common/logging/logger';
import type {
  BalanceHistoryQuery,
  BalanceQuery,
  CreatePayoutBody,
  PayoutListQuery,
  RetryItemBody,
  ReverseTransactionBody,
  SettlementBatchListQuery,
  SettlementItemListQuery,
  StagedInvoiceLinesResponse,
  TransactionListQuery,
} from './ledger.types';

export interface LedgerClientConfig {
  baseUrl: string;
  internalSecret: string;
}

/** `listSettlementItems` walks a whole batch; 10s is not enough on a 40k-item file. */
export const SETTLEMENT_ITEMS_READ_TIMEOUT_MS = 30_000;

@Injectable()
export class LedgerHttpClient extends BaseHttpClient {
  constructor(
    private readonly ledgerConfig: LedgerClientConfig,
    transport: HttpTransport,
    options: ApiClientOptions,
    retryPolicy: RetryPolicy,
    logger: PayzenoLogger,
  ) {
    super(transport, options, retryPolicy, logger);
  }

  protected get baseUrl(): string {
    return this.ledgerConfig.baseUrl;
  }

  listAccounts(merchantId: MerchantId, currency?: CurrencyCode): Promise<{ data: Account[] }> {
    return this.get<{ data: Account[] }>('/internal/v1/accounts', { merchant_id: merchantId, currency });
  }

  // -- transactions --------------------------------------------------------

  /**
   * Retried on the predicate above, and that retry is safe by contract: the request carries an
   * `idempotency_key` and the ledger discriminates repeats on `request_fingerprint`
   * (api-surface.md §10.2).
   */
  getSettlementBatch(batchId: SettlementBatchId, merchantId?: MerchantId): Promise<SettlementBatch> {
    return this.get<SettlementBatch>(`/internal/v1/settlement-batches/${encodeURIComponent(batchId)}`, {
      merchant_id: merchantId,
    });
  }

  listSettlementItems(
    batchId: SettlementBatchId,
    query: SettlementItemListQuery,
  ): Promise<Paginated<ReconciliationItem>> {
    return this.get<Paginated<ReconciliationItem>>(
      `/internal/v1/settlement-batches/${encodeURIComponent(batchId)}/items`,
      { ...query },
      SETTLEMENT_ITEMS_READ_TIMEOUT_MS,
    );
  }

  /**
   * The INC route. A `None` from the ledger's `RetryScheduler.retry_item` surfaces here as
   * `409 settlement_locked`, which `mapUpstreamFailure` turns into `LedgerRejectedException`
   * with the code intact. `SettlementsController` passes it straight to the console.
   */
  getPayout(payoutId: PayoutId): Promise<Payout> {
    return this.get<Payout>(`/internal/v1/payouts/${encodeURIComponent(payoutId)}`);
  }

}
