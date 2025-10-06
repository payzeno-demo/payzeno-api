import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import { LedgerRejectedException } from 'src/common/errors/upstream.exceptions';
import { LedgerHttpClient } from 'src/ledger/ledger-http.client';
import { LedgerReadThroughService } from 'src/ledger/ledger-read-through.service';

import { TEST_CHARGE_ID, TEST_MERCHANT_ID, TEST_OTHER_MERCHANT_ID } from 'test/factories/ids';

/**
 * L4. Everything the console reads about money passes through here, and its job is tenant
 * scoping: a `SettlementBatch` is an acquirer-level object with no `merchant_id`, so
 * `MerchantScopeGuard` cannot help. If this service ever returned one raw, every merchant
 * would see every other merchant's acquirer totals.
 */
describe('LedgerReadThroughService', () => {
  let ledger: jest.Mocked<LedgerHttpClient>;
  let service: LedgerReadThroughService;

  const batch = {
    id: 'sb_20260113_wf',
    object: 'settlement_batch',
    currency: 'GBP',
    processing_date: '2026-01-13',
    acquirer: 'worldflow',
    file_reference: 'WF-20260113-001',
    expected_total_minor: 9_812_400,
    posted_total_minor: 9_812_400,
    item_count: 3_140,
    status: 'reconciled',
    opened_at: '2026-01-13T00:00:00.000Z',
    closed_at: '2026-01-13T03:00:00.000Z',
    reconciled_at: '2026-01-13T04:20:00.000Z',
    funded_at: null,
  };

  const item = (net: number) => ({ id: `ri_${net}`, net_minor: net, merchant_id: TEST_MERCHANT_ID });

  beforeEach(() => {
    ledger = {
      getBalance: jest.fn().mockResolvedValue({ object: 'balance' }),
      getBalanceHistory: jest.fn().mockResolvedValue({ points: [] }),
      bootstrapAccounts: jest.fn().mockResolvedValue({ accounts: [], created: 3 }),
      listTransactions: jest.fn().mockResolvedValue({ data: [], next_cursor: null, has_more: false }),
      postTransaction: jest.fn().mockResolvedValue({ id: 'ltx_1' }),
      listPayouts: jest.fn().mockResolvedValue({ data: [], next_cursor: null, has_more: false }),
      getPayout: jest.fn(),
      createPayout: jest.fn(),
      cancelPayout: jest.fn(),
      listSettlementBatches: jest.fn().mockResolvedValue({ data: [batch], next_cursor: null, has_more: false }),
      getSettlementBatch: jest.fn().mockResolvedValue(batch),
      listSettlementItems: jest
        .fn()
        .mockResolvedValue({ data: [item(4_370), item(2_100)], next_cursor: null, has_more: false }),
      retryReconciliationItem: jest.fn().mockResolvedValue({ id: 'ri_000042', status: 'settling' }),
    } as unknown as jest.Mocked<LedgerHttpClient>;

    service = new LedgerReadThroughService(ledger);
  });

  describe('balances', () => {
    it('passes the currency and mode through', async () => {
      await service.getBalance(TEST_MERCHANT_ID, 'GBP', false);

      expect(ledger.getBalance).toHaveBeenCalledWith(TEST_MERCHANT_ID, {
        currency: 'GBP',
        livemode: false,
      });
    });

    it('defaults to livemode', async () => {
      await service.getBalance(TEST_MERCHANT_ID);

      expect(ledger.getBalance).toHaveBeenCalledWith(
        TEST_MERCHANT_ID,
        expect.objectContaining({ livemode: true }),
      );
    });

    it('reports how many accounts the bootstrap created', async () => {
      await expect(service.bootstrapAccounts(TEST_MERCHANT_ID, 'GBP', true)).resolves.toBe(3);
    });
  });

  describe('getChargeLedger', () => {
    it('queries transactions by charge reference, scoped to the merchant', async () => {
      await service.getChargeLedger(TEST_MERCHANT_ID, TEST_CHARGE_ID);

      expect(ledger.listTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          merchant_id: TEST_MERCHANT_ID,
          reference_type: 'charge',
          reference_id: TEST_CHARGE_ID,
        }),
      );
    });

    it('returns the charge id alongside the transactions', async () => {
      await expect(service.getChargeLedger(TEST_MERCHANT_ID, TEST_CHARGE_ID)).resolves.toEqual({
        charge_id: TEST_CHARGE_ID,
        transactions: [],
      });
    });
  });

  describe('recordCapture', () => {
    it('books the fee and the reserve on one posting', async () => {
      await service.recordCapture({
        chargeId: TEST_CHARGE_ID,
        merchantId: TEST_MERCHANT_ID,
        currency: 'GBP',
        livemode: true,
        amountMinor: 10_000,
        platformFeeBps: 290,
        platformFeeFixedMinor: 30,
        reserveBps: 500,
      } as never);

      const [req] = ledger.postTransaction.mock.calls[0];
      const lines = (req as { lines: Array<{ account_type: string; amount_minor: number }> }).lines;

      // 290bps of 10000 = 290, + 30 fixed = 320. Reserve 500bps = 500. Net = 9180.
      expect(lines).toEqual(
        expect.arrayContaining([
          { account_type: 'platform_fee_revenue', direction: 'credit', amount_minor: 320 },
          { account_type: 'reserve', direction: 'credit', amount_minor: 500 },
          { account_type: 'merchant_payable', direction: 'credit', amount_minor: 9_180 },
        ]),
      );
    });

    it('omits the reserve leg entirely when reserve_bps is zero', async () => {
      await service.recordCapture({
        chargeId: TEST_CHARGE_ID,
        merchantId: TEST_MERCHANT_ID,
        currency: 'GBP',
        livemode: true,
        amountMinor: 10_000,
        platformFeeBps: 290,
        platformFeeFixedMinor: 30,
        reserveBps: 0,
      } as never);

      const [req] = ledger.postTransaction.mock.calls[0];
      const lines = (req as { lines: Array<{ account_type: string }> }).lines;
      expect(lines.map((l) => l.account_type)).not.toContain('reserve');
    });

    it('balances debits and credits', async () => {
      await service.recordCapture({
        chargeId: TEST_CHARGE_ID,
        merchantId: TEST_MERCHANT_ID,
        currency: 'GBP',
        livemode: true,
        amountMinor: 10_000,
        platformFeeBps: 290,
        platformFeeFixedMinor: 30,
        reserveBps: 500,
      } as never);

      const [req] = ledger.postTransaction.mock.calls[0];
      const lines = (req as { lines: Array<{ direction: string; amount_minor: number }> }).lines;
      const debits = lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amount_minor, 0);
      const credits = lines.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.amount_minor, 0);

      expect(debits).toBe(credits);
    });

    it('uses a deterministic idempotency key derived from the charge', async () => {
      await service.recordCapture({
        chargeId: TEST_CHARGE_ID,
        merchantId: TEST_MERCHANT_ID,
        currency: 'GBP',
        livemode: true,
        amountMinor: 1_000,
        platformFeeBps: 0,
        platformFeeFixedMinor: 0,
        reserveBps: 0,
      } as never);

      const [req] = ledger.postTransaction.mock.calls[0];
      expect((req as { idempotency_key: string }).idempotency_key).toContain(TEST_CHARGE_ID);
    });
  });

  describe('payouts', () => {
    it('injects the merchant on a list', async () => {
      await service.listPayouts(TEST_MERCHANT_ID, { status: 'scheduled' } as never);

      expect(ledger.listPayouts).toHaveBeenCalledWith(
        expect.objectContaining({ merchant_id: TEST_MERCHANT_ID, status: 'scheduled' }),
      );
    });

    it('404s a payout belonging to another merchant', async () => {
      ledger.getPayout.mockResolvedValue({ id: 'po_1', merchant_id: TEST_OTHER_MERCHANT_ID } as never);

      await expect(service.getPayout(TEST_MERCHANT_ID, 'po_1')).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });

    it('returns a payout the merchant owns', async () => {
      ledger.getPayout.mockResolvedValue({ id: 'po_1', merchant_id: TEST_MERCHANT_ID } as never);

      await expect(service.getPayout(TEST_MERCHANT_ID, 'po_1')).resolves.toMatchObject({
        id: 'po_1',
      });
    });

    it('checks ownership before cancelling', async () => {
      ledger.getPayout.mockResolvedValue({ id: 'po_1', merchant_id: TEST_OTHER_MERCHANT_ID } as never);

      await expect(service.cancelPayout(TEST_MERCHANT_ID, 'po_1')).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
      expect(ledger.cancelPayout).not.toHaveBeenCalled();
    });
  });

  describe('settlements', () => {
    it('injects merchant_id on the batch list', async () => {
      await service.listSettlementBatches(TEST_MERCHANT_ID, {} as never);

      expect(ledger.listSettlementBatches).toHaveBeenCalledWith(
        expect.objectContaining({ merchant_id: TEST_MERCHANT_ID }),
      );
    });

    it('never returns acquirer-level totals', async () => {
      const page = await service.listSettlementBatches(TEST_MERCHANT_ID, {} as never);

      expect(page.data[0]).not.toHaveProperty('expected_total_minor');
      expect(page.data[0]).not.toHaveProperty('posted_total_minor');
      expect(page.data[0]).not.toHaveProperty('file_reference');
    });

    it('aggregates this merchant’s items into the view', async () => {
      const page = await service.listSettlementBatches(TEST_MERCHANT_ID, {} as never);

      expect(page.data[0]).toMatchObject({
        object: 'merchant_settlement_batch',
        merchant_id: TEST_MERCHANT_ID,
        item_count: 2,
        net_minor: 6_470,
      });
    });

    it('404s a batch the merchant has no item in', async () => {
      ledger.listSettlementItems.mockResolvedValue({ data: [], next_cursor: null, has_more: false } as never);

      await expect(
        service.getSettlementBatch(TEST_MERCHANT_ID, 'sb_20260113_wf'),
      ).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('injects merchant_id on the item list', async () => {
      await service.listSettlementItems(TEST_MERCHANT_ID, 'sb_20260113_wf', {} as never);

      expect(ledger.listSettlementItems).toHaveBeenCalledWith(
        'sb_20260113_wf',
        expect.objectContaining({ merchant_id: TEST_MERCHANT_ID }),
      );
    });

    it('does not swallow 409 settlement_locked on a retry', async () => {
      ledger.retryReconciliationItem.mockRejectedValue(
        new LedgerRejectedException('settlement_locked', 409, 'already settling'),
      );

      // Since PAY-2043 this is the ordinary outcome of racing a sweep. The console shows
      // "already settling" and refetches; turning it into a 502 would page someone.
      await expect(
        service.retrySettlementItem('ri_000042', { reason: 'operator' } as never),
      ).rejects.toMatchObject({ code: 'settlement_locked', status: 409 });
    });
  });
});
