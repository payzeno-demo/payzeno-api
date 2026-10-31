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
  type BalanceList,
  type CapturePostingCommand,
  type CreatePayoutBody,
  type DisputePostingCommand,
  type PayoutListQuery,
  type RefundPostingCommand,
  type RetryItemBody,
  type SettlementBatchListQuery,
  type SettlementItemListQuery,
} from './ledger.types';

/**
 * Page size for aggregating a merchant's items into `MerchantSettlementBatch`. The ledger caps
 * pages at 200 (`MAX_PAGE_SIZE`) and answers 422 above it, so this is the cap, and
 * `toMerchantView` walks pages rather than trusting the first one to be all of them.
 */
const ITEM_AGGREGATION_PAGE_SIZE = 200;

@Injectable()
export class LedgerReadThroughService {
  constructor(private readonly ledger: LedgerHttpClient) {}

  // -- balances ------------------------------------------------------------

  getBalance(merchantId: MerchantId, currency: CurrencyCode, livemode = true): Promise<Balance> {
    return this.ledger.getBalance(merchantId, { currency, livemode });
  }

  /**
   * Every currency the merchant holds a balance in (RFC platform-v2 §7: balances are per
   * currency, and nothing converts at capture). A ledger that predates the list answers the
   * currency-less read with one default-currency balance; that is a list of one.
   */
  async listBalances(merchantId: MerchantId, livemode = true): Promise<BalanceList> {
    const answer = await this.ledger.getBalance(merchantId, { livemode });
    return 'data' in answer ? { data: answer.data } : { data: [answer] };
  }

  getBalanceHistory(merchantId: MerchantId, query: BalanceHistoryQuery): Promise<BalanceHistoryResponse> {
    return this.ledger.getBalanceHistory(merchantId, query);
  }

  bootstrapAccounts(merchantId: MerchantId, currency: CurrencyCode, livemode: boolean): Promise<number> {
    return this.ledger
      .bootstrapAccounts(merchantId, currency, livemode)
      .then((response) => response.created);
  }

  // -- charge ledger view --------------------------------------------------

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
  recordCapture(command: CapturePostingCommand): Promise<LedgerTransaction> {
    const feeMinor = platformFee(command.amountMinor, command.platformFeeBps, command.platformFeeFixedMinor);
    const reserveMinor = Math.round((command.amountMinor * command.reserveBps) / 10_000);
    const netMinor = command.amountMinor - feeMinor - reserveMinor;

    return this.ledger.postTransaction({
      // Scoped by merchant, exactly as the ledger's PaymentEventConsumer keys the same fact.
      // Whichever of the two posts first wins; the other is a no-op on
      // uq_ledger_transaction_idempotency_key. Different keys meant both posted.
      idempotency_key: ledgerKey('capture', command.merchantId, command.chargeId),
      purpose: 'capture',
      merchant_id: command.merchantId,
      currency: command.currency,
      livemode: command.livemode,
      reference_type: 'charge',
      reference_id: command.chargeId,
      lines: [
        { account_type: 'authorization_hold', direction: 'debit', amount_minor: command.amountMinor },
        { account_type: 'merchant_payable', direction: 'credit', amount_minor: netMinor },
        { account_type: 'platform_fee_revenue', direction: 'credit', amount_minor: feeMinor },
        ...(reserveMinor > 0
          ? [{ account_type: 'reserve' as const, direction: 'credit' as const, amount_minor: reserveMinor }]
          : []),
      ],
    });
  }

  recordRefund(command: RefundPostingCommand): Promise<LedgerTransaction> {
    return this.ledger.postTransaction({
      idempotency_key: ledgerKey('refund', command.merchantId, command.refundId),
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
  recordDispute(command: DisputePostingCommand): Promise<LedgerTransaction> {
    return this.ledger.postTransaction({
      idempotency_key: ledgerKey('dispute', command.merchantId, command.disputeId),
      purpose: 'dispute',
      merchant_id: command.merchantId,
      currency: command.currency,
      livemode: command.livemode,
      reference_type: 'dispute',
      reference_id: command.disputeId,
      lines: [
        { account_type: 'merchant_payable', direction: 'debit', amount_minor: command.amountMinor },
        { account_type: 'chargeback_liability', direction: 'credit', amount_minor: command.amountMinor },
        { account_type: 'merchant_payable', direction: 'debit', amount_minor: command.feeMinor },
        { account_type: 'platform_fee_revenue', direction: 'credit', amount_minor: command.feeMinor },
      ],
    });
  }

  /** `voided` and `expired` both post this. There is no purpose named `ReleaseHold`. */
  releaseAuthorization(command: AuthReleaseCommand): Promise<LedgerTransaction> {
    return this.ledger.postTransaction({
      // `authrelease`, no underscore: the key purpose the ledger consumer uses, not the
      // posting purpose below.
      idempotency_key: ledgerKey('authrelease', command.merchantId, command.chargeId),
      purpose: 'auth_release',
      merchant_id: command.merchantId,
      currency: command.currency,
      livemode: command.livemode,
      reference_type: 'charge',
      reference_id: command.chargeId,
      lines: [
        { account_type: 'authorization_hold', direction: 'debit', amount_minor: command.amountMinor },
        { account_type: 'merchant_receivable', direction: 'credit', amount_minor: command.amountMinor },
      ],
    });
  }

  reverseTransaction(transactionId: string, reason: string): Promise<LedgerTransaction> {
    return this.ledger.reverseTransaction(transactionId, {
      reason,
      idempotency_key: ledgerKey('reversal', transactionId),
    });
  }

  // -- payouts -------------------------------------------------------------

  listPayouts(merchantId: MerchantId, query: Omit<PayoutListQuery, 'merchant_id'>): Promise<Paginated<Payout>> {
    return this.ledger.listPayouts({ ...query, merchant_id: merchantId });
  }

  async getPayout(merchantId: MerchantId, payoutId: PayoutId): Promise<Payout> {
    const payout = await this.ledger.getPayout(payoutId);
    if (payout.merchant_id !== merchantId) {
      // Cross-tenant reads are 404, never 403 — we do not confirm existence across tenants.
      throw new ResourceNotFoundException('payout', payoutId);
    }
    return payout;
  }

  createPayout(body: CreatePayoutBody, idempotencyKey: string): Promise<Payout> {
    return this.ledger.createPayout(body, idempotencyKey);
  }

  async cancelPayout(merchantId: MerchantId, payoutId: PayoutId): Promise<Payout> {
    await this.getPayout(merchantId, payoutId);
    return this.ledger.cancelPayout(payoutId);
  }

  // -- settlements ---------------------------------------------------------

  async listSettlementBatches(
    merchantId: MerchantId,
    query: Omit<SettlementBatchListQuery, 'merchant_id'>,
  ): Promise<Paginated<MerchantSettlementBatch>> {
    const page = await this.ledger.listSettlementBatches({ ...query, merchant_id: merchantId });
    const scoped = await Promise.all(page.data.map((batch) => this.toMerchantView(merchantId, batch)));
    return { data: scoped, next_cursor: page.next_cursor, has_more: page.has_more };
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
    let itemCount = 0;
    let netMinor = 0;
    let cursor: string | undefined;
    do {
      const page = await this.ledger.listSettlementItems(batch.id, {
        merchant_id: merchantId,
        limit: ITEM_AGGREGATION_PAGE_SIZE,
        cursor,
      });
      itemCount += page.data.length;
      netMinor += page.data.reduce((sum, item) => sum + Number(item.net_minor), 0);
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor);
    return {
      id: batch.id,
      object: 'merchant_settlement_batch',
      merchant_id: merchantId,
      currency: batch.currency,
      processing_date: batch.processing_date,
      acquirer: batch.acquirer,
      status: batch.status,
      item_count: itemCount,
      net_minor: netMinor,
      funded_at: batch.funded_at,
    };
  }
}

/** Blended pricing: bps of the amount plus a fixed minor charge. ROUND_HALF_UP on the bps leg. */
function platformFee(amountMinor: number, bps: number, fixedMinor: number): number {
  return Math.round((amountMinor * bps) / 10_000) + fixedMinor;
}
