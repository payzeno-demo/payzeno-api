import type {
  AccountId,
  Balance,
  BalanceHistoryResponse,
  BootstrapAccountsResponse,
  CreatePayoutRequest,
  CurrencyCode,
  LedgerTransaction,
  MerchantId,
  MerchantSettlementBatch,
  Paginated,
  Payout,
  PayoutId,
  PostTransactionRequest,
  ReconciliationItem,
  ReconciliationItemId,
  SettlementBatchId,
} from '@payzeno/contracts';

import { LedgerRejectedException } from 'src/common/errors/upstream.exceptions';
import type { LedgerHttpClient } from 'src/ledger/ledger-http.client';

/**
 * The second implementation of `LedgerHttpClient`'s surface (tests.md §2.1). The e2e suite
 * provides it in place of the real client so a booted app can walk
 * create → confirm → capture → refund → settle without payzeno-ledger running.
 *
 * It is a real implementation, not a jest mock: it keeps postings keyed on
 * `idempotency_key` and returns the *original* transaction on a repeat, because that is
 * the ledger's actual contract and the double-post assertions in
 * `test/e2e/payments.e2e-spec.ts` are worthless against a client that forgets.
 */
export class InMemoryLedgerClient implements Partial<LedgerHttpClient> {
  private readonly transactions = new Map<string, LedgerTransaction>();
  private readonly balances = new Map<string, Balance>();
  private readonly payouts = new Map<PayoutId, Payout>();
  private readonly batches = new Map<SettlementBatchId, MerchantSettlementBatch>();
  private readonly items = new Map<ReconciliationItemId, ReconciliationItem>();
  private readonly accounts = new Map<MerchantId, AccountId[]>();

  /** Every call, in order. Specs assert on paths without stubbing the transport. */
  readonly calls: Array<{ method: string; args: unknown[] }> = [];

  /** Set to make the next call of `method` reject the way the real ledger would. */
  private readonly rejections = new Map<string, LedgerRejectedException>();

  private seq = 0;

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const rejection = this.rejections.get(method);
    if (rejection) {
      this.rejections.delete(method);
      throw rejection;
    }
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq.toString(36).padStart(8, '0')}`;
  }

  /**
   * Arms a single `LedgerRejectedException` on the named method — the seam
   * `test/e2e/settlements.e2e-spec.ts` uses to reproduce `409 settlement_locked`.
   */
  rejectNext(method: keyof LedgerHttpClient, exception: LedgerRejectedException): void {
    this.rejections.set(method as string, exception);
  }

  callsTo(method: keyof LedgerHttpClient): Array<{ method: string; args: unknown[] }> {
    return this.calls.filter((c) => c.method === (method as string));
  }

  reset(): void {
    this.transactions.clear();
    this.balances.clear();
    this.payouts.clear();
    this.batches.clear();
    this.items.clear();
    this.accounts.clear();
    this.rejections.clear();
    this.calls.length = 0;
  }

  // -- accounts / balances --------------------------------------------------

  async bootstrapAccounts(
    merchantId: MerchantId,
    currency: CurrencyCode,
  ): Promise<BootstrapAccountsResponse> {
    this.record('bootstrapAccounts', merchantId, currency);
    const existing = this.accounts.get(merchantId);
    if (existing) {
      return { accounts: [], created: 0 };
    }
    const ids = ['merchant_payable', 'merchant_reserve', 'merchant_dispute_hold'].map(() =>
      this.nextId('acc'),
    );
    this.accounts.set(merchantId, ids);
    this.balances.set(`${merchantId}:${currency}`, this.emptyBalance(merchantId, currency));
    return { accounts: [], created: ids.length };
  }

  async getBalance(merchantId: MerchantId, currency: CurrencyCode): Promise<Balance> {
    this.record('getBalance', merchantId, currency);
    return this.balances.get(`${merchantId}:${currency}`) ?? this.emptyBalance(merchantId, currency);
  }

  async getBalanceHistory(
    merchantId: MerchantId,
    q: { currency: CurrencyCode; interval: 'hour' | 'day'; from: string; to: string },
  ): Promise<BalanceHistoryResponse> {
    this.record('getBalanceHistory', merchantId, q);
    return {
      merchant_id: merchantId,
      currency: q.currency,
      interval: q.interval,
      points: [{ bucket_start: q.from, amount_minor: 0, count: 0 }],
    };
  }

  /** Test-only helper: seed a balance the read-through service will surface. */
  seedBalance(balance: Balance): void {
    this.balances.set(`${balance.merchant_id}:${balance.currency}`, balance);
  }

  private emptyBalance(merchantId: MerchantId, currency: CurrencyCode): Balance {
    return {
      object: 'balance',
      merchant_id: merchantId,
      currency,
      available_minor: 0,
      pending_minor: 0,
      reserved_minor: 0,
      disputed_minor: 0,
      negative_balance_minor: 0,
      buckets: [],
      as_of: '2026-01-15T12:00:00.000Z',
    };
  }

  // -- transactions --------------------------------------------------------

  async postTransaction(req: PostTransactionRequest): Promise<LedgerTransaction> {
    this.record('postTransaction', req);
    const seen = this.transactions.get(req.idempotency_key);
    if (seen) {
      // The ledger returns the original posting, it does not post twice. Every
      // idempotency assertion in the e2e suite depends on this branch existing.
      return seen;
    }
    const txn: LedgerTransaction = {
      id: this.nextId('ltx'),
      object: 'ledger_transaction',
      idempotency_key: req.idempotency_key,
      request_fingerprint: `fp_${req.idempotency_key}`,
      purpose: req.purpose,
      merchant_id: req.merchant_id,
      currency: req.currency,
      livemode: req.livemode,
      reference_type: req.reference_type,
      reference_id: req.reference_id,
      reverses_transaction_id: null,
      created_by: 'system',
      entries: req.lines.map((line, index) => ({
        id: this.nextId('len'),
        object: 'ledger_entry',
        transaction_id: 'pending',
        account_id: this.nextId('acc'),
        direction: line.direction,
        amount_minor: line.amount_minor,
        currency: req.currency,
        sequence: index,
        created_at: '2026-01-15T12:00:00.000Z',
      })),
      posted_at: '2026-01-15T12:00:00.000Z',
    };
    this.transactions.set(req.idempotency_key, txn);
    return txn;
  }

  async listTransactions(q: {
    reference_type?: string;
    reference_id?: string;
    merchant_id?: MerchantId;
  }): Promise<Paginated<LedgerTransaction>> {
    this.record('listTransactions', q);
    const all = [...this.transactions.values()].filter((t) => {
      if (q.reference_type && t.reference_type !== q.reference_type) return false;
      if (q.reference_id && t.reference_id !== q.reference_id) return false;
      if (q.merchant_id && t.merchant_id !== q.merchant_id) return false;
      return true;
    });
    return { data: all, next_cursor: null, has_more: false };
  }

  async reverseTransaction(
    transactionId: string,
    req: { reason_code: string },
  ): Promise<LedgerTransaction> {
    this.record('reverseTransaction', transactionId, req);
    const original = [...this.transactions.values()].find((t) => t.id === transactionId);
    if (!original) {
      throw new LedgerRejectedException('not_found', 404, `transaction ${transactionId} not found`);
    }
    const reversal: LedgerTransaction = {
      ...original,
      id: this.nextId('ltx'),
      idempotency_key: `reverse:${transactionId}`,
      reverses_transaction_id: original.id,
      created_by: 'admin',
      entries: original.entries.map((e) => ({
        ...e,
        id: this.nextId('len'),
        direction: e.direction === 'debit' ? 'credit' : 'debit',
      })),
    };
    this.transactions.set(reversal.idempotency_key, reversal);
    return reversal;
  }

  // -- settlement ----------------------------------------------------------

  async listSettlementBatches(q: {
    merchant_id?: MerchantId;
  }): Promise<Paginated<MerchantSettlementBatch>> {
    this.record('listSettlementBatches', q);
    const data = [...this.batches.values()].filter(
      (b) => !q.merchant_id || b.merchant_id === q.merchant_id,
    );
    return { data, next_cursor: null, has_more: false };
  }

  async getSettlementBatch(batchId: SettlementBatchId): Promise<MerchantSettlementBatch> {
    this.record('getSettlementBatch', batchId);
    const batch = this.batches.get(batchId);
    if (!batch) {
      throw new LedgerRejectedException('not_found', 404, `batch ${batchId} not found`);
    }
    return batch;
  }

  async listSettlementItems(
    batchId: SettlementBatchId,
    q: { merchant_id: MerchantId; status?: string },
  ): Promise<Paginated<ReconciliationItem>> {
    this.record('listSettlementItems', batchId, q);
    const data = [...this.items.values()].filter(
      (i) =>
        i.batch_id === batchId &&
        i.merchant_id === q.merchant_id &&
        (!q.status || i.status === q.status),
    );
    return { data, next_cursor: null, has_more: false };
  }

  async retryReconciliationItem(
    itemId: ReconciliationItemId,
    req: { reason?: string },
  ): Promise<ReconciliationItem> {
    this.record('retryReconciliationItem', itemId, req);
    const item = this.items.get(itemId);
    if (!item) {
      throw new LedgerRejectedException('not_found', 404, `item ${itemId} not found`);
    }
    if (item.status === 'settled') {
      // Racing a sweep. After PAY-2043 this is the common outcome, not an error.
      throw new LedgerRejectedException('settlement_locked', 409, 'item already settled', {
        item_id: itemId,
        settled_transaction_id: item.settled_transaction_id,
      });
    }
    const retried: ReconciliationItem = {
      ...item,
      status: 'settling',
      attempt_count: item.attempt_count + 1,
      last_attempt_at: '2026-01-15T12:00:00.000Z',
    };
    this.items.set(itemId, retried);
    return retried;
  }

  seedBatch(batch: MerchantSettlementBatch, items: ReconciliationItem[] = []): void {
    this.batches.set(batch.id, batch);
    for (const item of items) {
      this.items.set(item.id, item);
    }
  }

  // -- payouts -------------------------------------------------------------

  async listPayouts(q: { merchant_id?: MerchantId; status?: string }): Promise<Paginated<Payout>> {
    this.record('listPayouts', q);
    const data = [...this.payouts.values()].filter(
      (p) =>
        (!q.merchant_id || p.merchant_id === q.merchant_id) && (!q.status || p.status === q.status),
    );
    return { data, next_cursor: null, has_more: false };
  }

  async getPayout(payoutId: PayoutId): Promise<Payout> {
    this.record('getPayout', payoutId);
    const payout = this.payouts.get(payoutId);
    if (!payout) {
      throw new LedgerRejectedException('not_found', 404, `payout ${payoutId} not found`);
    }
    return payout;
  }

  async createPayout(req: CreatePayoutRequest & { merchant_id: MerchantId }): Promise<Payout> {
    this.record('createPayout', req);
    const payout: Payout = {
      id: this.nextId('po'),
      object: 'payout',
      merchant_id: req.merchant_id,
      bank_account_id: req.bank_account_id ?? 'ba_default',
      amount_minor: req.amount_minor ?? 0,
      currency: req.currency,
      status: 'scheduled',
      method: req.method ?? 'standard',
      available_on: '2026-01-17',
      arrival_estimate: '2026-01-19',
      statement_descriptor: req.statement_descriptor ?? 'PAYZENO',
      failure_code: null,
      ledger_transaction_id: null,
      reversal_transaction_id: null,
      livemode: true,
      initiated_at: null,
      paid_at: null,
      failed_at: null,
      returned_at: null,
      created_at: '2026-01-15T12:00:00.000Z',
    };
    this.payouts.set(payout.id, payout);
    return payout;
  }

  async cancelPayout(payoutId: PayoutId): Promise<Payout> {
    this.record('cancelPayout', payoutId);
    const payout = await this.getPayout(payoutId);
    if (payout.status !== 'scheduled') {
      throw new LedgerRejectedException('payout_blocked', 422, 'payout already in flight', {
        status: payout.status,
      });
    }
    const canceled: Payout = { ...payout, status: 'canceled' };
    this.payouts.set(payoutId, canceled);
    return canceled;
  }

  seedPayout(payout: Payout): void {
    this.payouts.set(payout.id, payout);
  }
}
