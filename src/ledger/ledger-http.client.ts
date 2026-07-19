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

  protected defaultHeaders(): Record<string, string> {
    return {
      'x-payzeno-service': 'payzeno-api',
      'x-payzeno-internal-secret': this.ledgerConfig.internalSecret,
    };
  }

  // -- accounts & balances -------------------------------------------------

  bootstrapAccounts(merchantId: MerchantId, currency: CurrencyCode, livemode = true): Promise<BootstrapAccountsResponse> {
    return this.request<BootstrapAccountsResponse, { merchant_id: MerchantId; currency: CurrencyCode; livemode: boolean }>({
      method: 'POST',
      path: '/internal/v1/accounts/bootstrap',
      body: { merchant_id: merchantId, currency, livemode },
      idempotencyKey: `bootstrap:${merchantId}:${currency}`,
    });
  }

  getBalance(merchantId: MerchantId, query: BalanceQuery = {}): Promise<Balance> {
    return this.get<Balance>(`/internal/v1/balances/${encodeURIComponent(merchantId)}`, { ...query });
  }

  getBalanceHistory(merchantId: MerchantId, query: BalanceHistoryQuery): Promise<BalanceHistoryResponse> {
    return this.get<BalanceHistoryResponse>(`/internal/v1/balances/${encodeURIComponent(merchantId)}/history`, {
      ...query,
    });
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
  postTransaction(req: PostTransactionRequest): Promise<LedgerTransaction> {
    return this.request<LedgerTransaction, PostTransactionRequest>({
      method: 'POST',
      path: '/internal/v1/transactions',
      body: req,
      idempotencyKey: req.idempotency_key,
    });
  }

  listTransactions(query: TransactionListQuery): Promise<Paginated<LedgerTransaction>> {
    return this.get<Paginated<LedgerTransaction>>('/internal/v1/transactions', { ...query });
  }

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
  retryReconciliationItem(itemId: string, body: RetryItemBody): Promise<ReconciliationItem> {
    return this.request<ReconciliationItem, RetryItemBody>({
      method: 'POST',
      path: `/internal/v1/reconciliation/items/${encodeURIComponent(itemId)}/retry`,
      body,
      idempotencyKey: `retry:${itemId}`,
    });
  }

  // -- invoices (arc MIG, dead in production) ------------------------------

  /**
   * The other arm of `InvoiceSourceResolver`. Reads the lines the ledger accumulates in
   * `invoice_line_staging` behind flag `ledger_owns_invoices`, which is false and has been
   * false for six months. This method compiles, has a spec, and has never been called in
   * production — that is arc MIG step 4, and it is unfinished on purpose.
   *
   * docs/adr/0012-invoice-cutover.md.
   */
  listStagedInvoiceLines(
    merchantId: MerchantId,
    invoicePublicId: string,
  ): Promise<StagedInvoiceLinesResponse> {
    return this.get<StagedInvoiceLinesResponse>('/internal/v1/invoices/lines', {
      merchant_id: merchantId,
      invoice_public_id: invoicePublicId,
    });
  }

  // -- payouts -------------------------------------------------------------

  listPayouts(query: PayoutListQuery): Promise<Paginated<Payout>> {
    return this.get<Paginated<Payout>>('/internal/v1/payouts', { ...query });
  }

  getPayout(payoutId: PayoutId): Promise<Payout> {
    return this.get<Payout>(`/internal/v1/payouts/${encodeURIComponent(payoutId)}`);
  }

  createPayout(body: CreatePayoutBody, idempotencyKey: string): Promise<Payout> {
    return this.request<Payout, CreatePayoutBody>({
      method: 'POST',
      path: '/internal/v1/payouts',
      body,
      idempotencyKey,
    });
  }

  cancelPayout(payoutId: PayoutId): Promise<Payout> {
    return this.request<Payout, Record<string, never>>({
      method: 'POST',
      path: `/internal/v1/payouts/${encodeURIComponent(payoutId)}/cancel`,
      body: {},
      idempotencyKey: `payout_cancel:${payoutId}`,
    });
  }

  // -- error translation ---------------------------------------------------

  protected mapUpstreamFailure(failure: UpstreamFailure): never {
    if (failure.apiError) {
      const { code, message, details } = failure.apiError.error;
      throw new LedgerRejectedException(code, failure.status, message, details);
    }
    // No parseable envelope. Either the ledger is behind a proxy that answered for it, or it
    // died mid-response. Both are transport failures as far as the caller is concerned.
    throw new LedgerUnavailableException(
      `payzeno-ledger responded ${failure.status} with an unparseable body for ${failure.spec.method} ${failure.spec.path}`,
      { status: failure.status },
    );
  }

  protected mapTransportFailure(err: TransportError, spec: RequestSpec<unknown>): never {
    throw new LedgerUnavailableException(
      `payzeno-ledger ${err.kind} on ${spec.method} ${spec.path}`,
      { failure: err.kind },
    );
  }
}
