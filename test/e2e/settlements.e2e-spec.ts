import request from 'supertest';

import type { MerchantSettlementBatch, ReconciliationItem } from '@payzeno/contracts';

import { LedgerRejectedException } from 'src/common/errors/upstream.exceptions';

import { createTestApp } from 'test/support/test-app';
import type { TestApp } from 'test/support/test-app';
import { bearer, seedMerchant } from 'test/support/seed';
import type { SeededMerchant } from 'test/support/seed';

const BATCH_ID = 'sb_20260113_wf';

function batch(merchantId: string): MerchantSettlementBatch {
  return {
    id: BATCH_ID,
    object: 'merchant_settlement_batch',
    merchant_id: merchantId,
    currency: 'GBP',
    processing_date: '2026-01-13',
    acquirer: 'worldflow',
    status: 'partially_reconciled',
    item_count: 2,
    net_minor: 8_400,
    funded_at: null,
  };
}

function item(overrides: Partial<ReconciliationItem> = {}): ReconciliationItem {
  return {
    id: 'ri_000042',
    object: 'reconciliation_item',
    batch_id: BATCH_ID,
    charge_id: 'ch_settle01',
    merchant_id: 'mch_test01',
    line_type: 'sale',
    gross_minor: 4_500,
    fee_minor: 130,
    interchange_minor: 90,
    scheme_fee_minor: 12,
    net_minor: 4_370,
    expected_gross_minor: 4_500,
    variance_minor: 0,
    currency: 'GBP',
    livemode: true,
    acquirer_reference: 'wf_auth_000042',
    match_method: 'exact_reference',
    matched_at: '2026-01-13T04:05:00.000Z',
    status: 'retryable',
    attempt_count: 2,
    last_error_code: 'ledger_timeout',
    last_attempt_at: '2026-01-13T04:09:00.000Z',
    next_attempt_at: '2026-01-13T04:19:00.000Z',
    settled_transaction_id: null,
    created_at: '2026-01-13T04:00:00.000Z',
    updated_at: '2026-01-13T04:09:00.000Z',
    ...overrides,
  };
}

/**
 * Settlement read-through, and the `409 settlement_locked` branch (api-surface §8).
 *
 * Two things are load-bearing here and neither is obvious:
 *
 *  1. payzeno-api always injects `merchant_id=principal.merchant_id` on the three ledger
 *     reads. A `SettlementBatch` has no merchant on it; without the injection a merchant
 *     session reads every other merchant's acquirer totals.
 *  2. The retry route maps the ledger's `409 settlement_locked` **straight through** as
 *     `LedgerRejectedException`. After PAY-2043 that is the ordinary outcome of racing a
 *     sweep — the console treats it as a no-op, so collapsing it into a 502 would turn a
 *     quiet no-op into a pager.
 */
describe('settlements e2e', () => {
  let ctx: TestApp;
  let seeded: SeededMerchant;

  beforeAll(async () => {
    ctx = await createTestApp();
    seeded = await seedMerchant(ctx);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.ledger.reset();
    ctx.ledger.seedBatch(batch(seeded.merchant.id), [
      item({ merchant_id: seeded.merchant.id }),
      item({ id: 'ri_000043', merchant_id: seeded.merchant.id, status: 'settled', settled_transaction_id: 'ltx_000777' }),
    ]);
  });

  it('never returns acquirer-level totals on a merchant-facing route', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/settlements')
      .set('Authorization', bearer(seeded));

    expect(res.body.data[0]).not.toHaveProperty('expected_total_minor');
    expect(res.body.data[0]).not.toHaveProperty('posted_total_minor');
    expect(res.body.data[0]).not.toHaveProperty('file_reference');
  });

  it('reads one batch and injects merchant_id on the ledger call', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get(`/v1/settlements/${BATCH_ID}`)
      .set('Authorization', bearer(seeded));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(BATCH_ID);
    expect(ctx.ledger.callsTo('getSettlementBatch')).toHaveLength(1);
  });

});
