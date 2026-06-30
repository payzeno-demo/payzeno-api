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
  let adapter: NordpayAdapter;

  const euroAuth: AuthorizeRequest = {
    chargeId: 'ch_np00000001',
    merchantId: 'mch_np01',
    amountMinor: 9_900,
    currency: 'EUR',
    paymentMethodToken: 'pmt_visa_0002',
    captureMethod: 'automatic',
    statementDescriptor: 'AURORA EU',
    threeDSecure: { returnUrl: 'https://aurora.example/3ds', challengePreference: 'auto' },
    idempotencyKey: 'auth:ch_np00000001',
  };

  function approval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      outcome: 'APPROVED',
      scheme_transaction_id: 'ntx_np_0001',
      auth_code: 'N44120',
      reference: 'np_auth_0001',
      refusal_reason: null,
      fraud_score: 8,
      card: {
        scheme: 'VISA',
        last_digits: '0002',
        expiry_month: 4,
        expiry_year: 2028,
        issuer_country_code: 'DE',
        funding_source: 'CREDIT',
      },
      authentication: {
        protocol_version: '2.2.0',
        flow: 'frictionless',
        status: 'Y',
        eci: '05',
        liability_shift: true,
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    transport = new InMemoryTransport();
    adapter = buildNordpay(transport, new FixedClock('2026-01-15T12:00:00.000Z')).adapter;
  });

  it('identifies itself as nordpay', () => {
    expect(adapter.acquirer).toBe('nordpay');
  });

  it('calls the nordpay base URL, not worldflow’s', async () => {
    transport.on('GET', '/v2/health', () => ({ status: 200, body: { status: 'ok' } }));

    await adapter.healthCheck();

    expect(transport.callsTo('GET', '/v2/health')[0].url).toContain('nordpay.test:9101');
  });

  it('sends its own credentials', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 200, body: approval() }));

    await adapter.authorize(euroAuth);

    const [call] = transport.callsTo('POST', '/v2/authorizations');
    expect(call.headers.authorization).toBe('Bearer np_test_key');
    expect(call.headers['payzeno-acquirer-account']).toBe('np-acct-payzeno');
  });

  it('maps an approval, translating the card vocabulary', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 200, body: approval() }));

    const result = await adapter.authorize(euroAuth);

    expect(result).toMatchObject({
      approved: true,
      networkTransactionId: 'ntx_np_0001',
      authorizationCode: 'N44120',
      processorReference: 'np_auth_0001',
      riskScore: 8,
    });
    expect(result.card).toMatchObject({ brand: 'visa', last_four: '0002', country: 'DE' });
  });

  describe('3-D Secure transStatus mapping', () => {
    it.each([
      ['Y', 'authenticated'],
      ['A', 'attempted'],
      ['N', 'failed'],
      ['U', 'unavailable'],
    ])('maps status %s to %s', async (status, expected) => {
      transport.on('POST', '/v2/authorizations', () => ({
        status: 200,
        body: approval({
          authentication: {
            protocol_version: '2.2.0',
            flow: 'frictionless',
            status,
            eci: '06',
            liability_shift: status === 'Y',
          },
        }),
      }));

      const result = await adapter.authorize(euroAuth);

      expect(result.threeDSecure?.result).toBe(expected);
    });

    it('carries liability_shift through untouched', async () => {
      transport.on('POST', '/v2/authorizations', () => ({
        status: 200,
        body: approval({
          authentication: {
            protocol_version: '2.2.0',
            flow: 'frictionless',
            status: 'A',
            eci: '06',
            liability_shift: false,
          },
        }),
      }));

      const result = await adapter.authorize(euroAuth);

      expect(result.threeDSecure?.liabilityShifted).toBe(false);
    });

    it('returns a null 3DS block when nordpay omits it', async () => {
      transport.on('POST', '/v2/authorizations', () => ({
        status: 200,
        body: approval({ authentication: null }),
      }));

      const result = await adapter.authorize(euroAuth);

      expect(result.threeDSecure).toBeNull();
    });
  });

  it('surfaces AUTHENTICATION_REQUIRED as not-approved so the intent can go to requires_action', async () => {
    transport.on('POST', '/v2/authorizations', () => ({
      status: 200,
      body: approval({
        outcome: 'AUTHENTICATION_REQUIRED',
        scheme_transaction_id: null,
        auth_code: null,
        authentication: {
          protocol_version: '2.2.0',
          flow: 'challenge',
          status: 'U',
          eci: '07',
          liability_shift: false,
        },
      }),
    }));

    const result = await adapter.authorize(euroAuth);

    expect(result.approved).toBe(false);
    expect(result.threeDSecure?.authenticationFlow).toBe('challenge');
  });

  it('maps a refusal reason onto a payzeno decline code', async () => {
    transport.on('POST', '/v2/authorizations', () => ({
      status: 200,
      body: approval({
        outcome: 'DECLINED',
        scheme_transaction_id: null,
        auth_code: null,
        refusal_reason: 'ISSUER_UNAVAILABLE',
        authentication: null,
      }),
    }));

    const result = await adapter.authorize(euroAuth);

    expect(result.approved).toBe(false);
    expect(result.declineCode).toBe('issuer_unavailable');
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

  it('throws ProcessorUnavailableException on a 504', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 504, body: {} }));

    await expect(adapter.authorize(euroAuth)).rejects.toBeInstanceOf(ProcessorUnavailableException);
  });
});
