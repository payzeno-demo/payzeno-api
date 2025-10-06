/**
 * L4 gateway service — the read-through half of the money path.
 *
 * Every merchant-facing balance, payout and settlement read goes through here, and every one
 * of them injects `merchant_id = principal.merchant_id` before it reaches the ledger. That
 * injection is not a convenience: a `SettlementBatch` is an acquirer-level object with no
 * `merchant_id`, so `MerchantScopeGuard` cannot scope it, and returning the raw object to a
 * merchant session exposes every other merchant's acquirer totals (api-surface.md §8).
 *
 * `settlements.service.ts` is deliberately folded into this file — a service that did nothing
 * but forward to this one was three files of indirection for one call.
 */

import { Injectable } from '@nestjs/common';
import type {
  Balance,
  BalanceHistoryResponse,
  ChargeId,
  ChargeLedgerResponse,
  CurrencyCode,
  LedgerTransaction,
  MerchantId,
  MerchantSettlementBatch,
  Paginated,
  Payout,
  PayoutId,
  ReconciliationItem,
  SettlementBatch,
  SettlementBatchId,
} from '@payzeno/contracts';

import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { LedgerHttpClient } from './ledger-http.client';
import {
  ledgerKey,
  type AuthReleaseCommand,
  type BalanceHistoryQuery,
  type CapturePostingCommand,
  type CreatePayoutBody,
  type DisputePostingCommand,
  type PayoutListQuery,
  type RefundPostingCommand,
  type RetryItemBody,
  type SettlementBatchListQuery,
  type SettlementItemListQuery,
} from './ledger.types';

/** How many of a merchant's items we aggregate to build `MerchantSettlementBatch`. */
const ITEM_AGGREGATION_PAGE_SIZE = 500;

@Injectable()
export class LedgerReadThroughService {
  constructor(private readonly ledger: LedgerHttpClient) {}

  // -- balances ------------------------------------------------------------

  getBalanceHistory(merchantId: MerchantId, query: BalanceHistoryQuery): Promise<BalanceHistoryResponse> {
    return this.ledger.getBalanceHistory(merchantId, query);
  }

  /** `GET /v1/charges/:chargeId/ledger` — every transaction that references this charge. */
  async getChargeLedger(merchantId: MerchantId, chargeId: ChargeId): Promise<ChargeLedgerResponse> {
    const page = await this.ledger.listTransactions({
      merchant_id: merchantId,
      reference_type: 'charge',
      reference_id: chargeId,
      limit: 100,
    });
    return { charge_id: chargeId, transactions: page.data };
  }

  // -- postings ------------------------------------------------------------

  /**
   * The `capture` posting. Carries the platform fee and the reserve hold, because per-charge
   * processing fees are booked HERE and by nothing else — a second `fee:` posting for the same
   * charge double-counts both Payzeno's revenue and the merchant's payable deduction
   * (domain-model.md §7).
   */
  recordRefund(command: RefundPostingCommand): Promise<LedgerTransaction> {
    return this.ledger.postTransaction({
      idempotency_key: ledgerKey('refund', command.chargeId, command.refundId),
      purpose: 'refund',
      merchant_id: command.merchantId,
      currency: command.currency,
      livemode: command.livemode,
      reference_type: 'refund',
      reference_id: command.refundId,
      lines: [
        { account_type: 'merchant_payable', direction: 'debit', amount_minor: command.amountMinor },
        { account_type: 'processor_clearing', direction: 'credit', amount_minor: command.amountMinor },
      ],
    });
  }

  /**
   * Two legs, and they behave differently on `won` (domain-model.md §5): the disputed amount
   * is reversed, the chargeback fee is not — the network keeps it whichever way the case goes.
   */
  reverseTransaction(transactionId: string, reason: string): Promise<LedgerTransaction> {
    return this.ledger.reverseTransaction(transactionId, {
      reason,
      idempotency_key: ledgerKey('reversal', transactionId),
    });
  }

  // -- payouts -------------------------------------------------------------

  createPayout(body: CreatePayoutBody, idempotencyKey: string): Promise<Payout> {
    return this.ledger.createPayout(body, idempotencyKey);
  }

  async getSettlementBatch(merchantId: MerchantId, batchId: SettlementBatchId): Promise<MerchantSettlementBatch> {
    const batch = await this.ledger.getSettlementBatch(batchId, merchantId);
    const view = await this.toMerchantView(merchantId, batch);
    if (view.item_count === 0) {
      // The merchant has nothing in this batch, so as far as they are concerned it does not
      // exist (api-surface.md §8).
      throw new ResourceNotFoundException('settlement_batch', batchId);
    }
    return view;
  }

  listSettlementItems(
    merchantId: MerchantId,
    batchId: SettlementBatchId,
    query: Omit<SettlementItemListQuery, 'merchant_id'>,
  ): Promise<Paginated<ReconciliationItem>> {
    return this.ledger.listSettlementItems(batchId, { ...query, merchant_id: merchantId });
  }

  /**
   * `POST /v1/settlements/:batchId/items/:itemId/retry`.
   *
   * The ledger answers `409 settlement_locked` when `RetryScheduler.retry_item` returns `None`
   * — the item is not retryable, or a sweep holds the batch advisory lock. Since PAY-2043 that
   * is the *normal* outcome of racing a sweep, not a failure: the sweep is settling the item
   * anyway. `LedgerHttpClient` raises `LedgerRejectedException` with the code intact and this
   * method does not swallow it; the console shows "already settling" and refetches.
   */
  retrySettlementItem(itemId: string, body: RetryItemBody): Promise<ReconciliationItem> {
    return this.ledger.retryReconciliationItem(itemId, body);
  }

  /**
   * Builds the merchant-scoped view. `expected_total_minor` / `posted_total_minor` are
   * acquirer-level and never cross this boundary.
   *
   * The per-merchant aggregation is done here because the ledger has no merchant-scoped totals
   * endpoint yet — PAY-1904 tracks adding one, at which point this reduces to a field copy.
   */
  private async toMerchantView(
    merchantId: MerchantId,
    batch: SettlementBatch,
  ): Promise<MerchantSettlementBatch> {
    const items = await this.ledger.listSettlementItems(batch.id, {
      merchant_id: merchantId,
      limit: ITEM_AGGREGATION_PAGE_SIZE,
    });
    const netMinor = items.data.reduce((sum, item) => sum + Number(item.net_minor), 0);
    return {
      id: batch.id,
      object: 'merchant_settlement_batch',
      merchant_id: merchantId,
      currency: batch.currency,
      processing_date: batch.processing_date,
      acquirer: batch.acquirer,
      status: batch.status,
      item_count: items.data.length,
      net_minor: netMinor,
      funded_at: batch.funded_at,
    };
  }
}

/** Blended pricing: bps of the amount plus a fixed minor charge. ROUND_HALF_UP on the bps leg. */
function platformFee(amountMinor: number, bps: number, fixedMinor: number): number {
  return Math.round((amountMinor * bps) / 10_000) + fixedMinor;
}
