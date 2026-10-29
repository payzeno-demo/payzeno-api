import type { Payout } from '@payzeno/contracts';

import { withConversion } from 'src/ledger/payouts.service';

function payout(overrides: Partial<Payout> = {}): Payout {
  return {
    id: 'po_01HQ8Z3K9X4M2N7P6R5T1V0W8Y',
    object: 'payout',
    merchant_id: 'mch_01HQ8Z3K9X4M2N7P6R5T1V0W8Y',
    bank_account_id: 'ba_01HQ8Z3K9X4M2N7P6R5T1V0W8Y',
    amount_minor: 9_150,
    currency: 'USD',
    status: 'scheduled',
    method: 'standard_ach',
    available_on: '2026-10-30',
    arrival_estimate: null,
    statement_descriptor: 'PAYZENO',
    failure_code: null,
    ledger_transaction_id: null,
    reversal_transaction_id: null,
    livemode: true,
    initiated_at: null,
    paid_at: null,
    failed_at: null,
    returned_at: null,
    created_at: '2026-10-29T08:00:00.000Z',
    source_amount_minor: null,
    source_currency: null,
    fx_rate: null,
    ...overrides,
  };
}

describe('withConversion', () => {
  it('passes a converted payout through untouched', () => {
    const converted = payout({ source_amount_minor: 10_000, source_currency: 'EUR', fx_rate: '1.0842' });
    expect(withConversion(converted)).toEqual(converted);
  });

  it('fills the conversion fields with null when the ledger sent none', () => {
    // A ledger that predates conversion sends the payout without the three keys at all.
    const bare: Partial<Payout> = payout();
    delete bare.source_amount_minor;
    delete bare.source_currency;
    delete bare.fx_rate;
    const filled = withConversion(bare as Payout);
    expect(filled.source_amount_minor).toBeNull();
    expect(filled.source_currency).toBeNull();
    expect(filled.fx_rate).toBeNull();
  });
});
