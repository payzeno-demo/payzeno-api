import { InMemoryTransport } from 'src/api/in-memory-transport';
import { ProcessorUnavailableException } from 'src/common/errors/upstream.exceptions';
import type { AuthorizeRequest } from 'src/payments/processor/processor.types';
import type { NordpayAdapter } from 'src/payments/processor/nordpay.adapter';

import { buildNordpay } from 'test/support/acquirer-harness';
import { FixedClock } from 'test/support/fixed-clock';

/**
 * Nordpay speaks the same route shape as Worldflow (api-surface §15) against a different
 * base URL and a different response vocabulary: it is a 3DS-first acquirer and returns
 * the authentication block on every EUR/GBP e-commerce authorisation, with the scheme's
 * raw `transStatus` letters rather than words.
 *
 * The Y/A/N/U mapping is the whole reason this file exists separately from the contract
 * suite: `liability_shift` decides whether a `fraudulent` chargeback is the merchant's
 * loss, and getting `A` wrong silently moves that liability.
 */
describe('NordpayAdapter', () => {
  let transport: InMemoryTransport;
  it('identifies itself as nordpay', () => {
    expect(adapter.acquirer).toBe('nordpay');
  });

  it('sends its own credentials', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 200, body: approval() }));

    await adapter.authorize(euroAuth);

    const [call] = transport.callsTo('POST', '/v2/authorizations');
    expect(call.headers.authorization).toBe('Bearer np_test_key');
    expect(call.headers['payzeno-acquirer-account']).toBe('np-acct-payzeno');
  });

  it('captures against the same route shape as worldflow', async () => {
    transport.on('POST', '/v2/authorizations/:ntx/captures', () => ({
      status: 200,
      body: {
        outcome: 'CAPTURED',
        reference: 'np_cap_0001',
        amount: { value: 9_900, currency: 'EUR' },
        processed_at: '2026-01-15T12:00:00.000Z',
      },
    }));

    const result = await adapter.capture({
      networkTransactionId: 'ntx_np_0001',
      amountMinor: 9_900,
      currency: 'EUR',
      idempotencyKey: 'capture:ch_np00000001',
    });

    expect(transport.callsTo('POST', /captures$/)[0].path).toBe(
      '/v2/authorizations/ntx_np_0001/captures',
    );
    expect(result.captured).toBe(true);
    expect(result.capturedAmountMinor).toBe(9_900);
  });

  it('reports a refused refund without throwing', async () => {
    transport.on('POST', '/v2/refunds', () => ({
      status: 200,
      body: { outcome: 'REFUSED', reference: 'np_ref_1', refusal_reason: 'ORIGINAL_NOT_SETTLED' },
    }));

    const result = await adapter.refund({
      networkTransactionId: 'ntx_np_0001',
      amountMinor: 1_000,
      currency: 'EUR',
      reason: 'requested_by_customer',
      idempotencyKey: 'refund:re_np_1',
    });

    expect(result.refunded).toBe(false);
    expect(result.failureReason).toBe('ORIGINAL_NOT_SETTLED');
  });

});
