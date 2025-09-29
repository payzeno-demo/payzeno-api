import { InMemoryTransport } from 'src/api/in-memory-transport';
import { TransportError } from 'src/api/transport.interface';
import { InsufficientFundsException } from 'src/common/errors/card.exceptions';
import { ProcessorUnavailableException } from 'src/common/errors/upstream.exceptions';
import type { AuthorizeRequest } from 'src/payments/processor/processor.types';
import type { WorldflowAdapter } from 'src/payments/processor/worldflow.adapter';

import {
  buildWorldflow,
  signAcquirerWebhook,
  worldflowApproval,
  worldflowDecline,
} from 'test/support/acquirer-harness';
import { FixedClock } from 'test/support/fixed-clock';
import type { ProcessorSignatureVerifier } from 'src/payments/processor/processor-signature.verifier';

/**
 * Wire-level assertions against api-surface.md §15. The paths are frozen there for a
 * reason: `capture` is `POST /v2/authorizations/{ntx}/captures`, which is also what
 * payzeno-ledger's `ProcessorClient.capture_deferred` calls — the single most
 * load-bearing external call in the platform, and the one that fires twice in arc INC.
 */
describe('WorldflowAdapter', () => {
  let transport: InMemoryTransport;
  let adapter: WorldflowAdapter;
  let verifier: ProcessorSignatureVerifier;
  let clock: FixedClock;

  const authorizeRequest: AuthorizeRequest = {
    chargeId: 'ch_wf00000001',
    merchantId: 'mch_wf01',
    amountMinor: 4_500,
    currency: 'GBP',
    paymentMethodToken: 'pmt_visa_4242',
    captureMethod: 'automatic',
    statementDescriptor: 'AURORA',
    threeDSecure: null,
    idempotencyKey: 'auth:ch_wf00000001',
  };

  beforeEach(() => {
    transport = new InMemoryTransport();
    clock = new FixedClock('2026-01-15T12:00:00.000Z');
    const harness = buildWorldflow(transport, clock);
    adapter = harness.adapter;
    verifier = harness.verifier;
  });

  it('identifies itself as worldflow', () => {
    expect(adapter.acquirer).toBe('worldflow');
  });

  it('POSTs /v2/authorizations with the idempotency key and acquirer credentials', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 200, body: worldflowApproval() }));

    await adapter.authorize(authorizeRequest);

    const [call] = transport.callsTo('POST', '/v2/authorizations');
    expect(call.headers['idempotency-key']).toBe('auth:ch_wf00000001');
    expect(call.headers.authorization).toBe('Bearer wf_test_key');
    expect(call.headers['payzeno-acquirer-account']).toBe('wf-acct-payzeno');
  });

  it('sends the acquirer’s own field names, not payzeno’s', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 200, body: worldflowApproval() }));

    await adapter.authorize(authorizeRequest);

    const [call] = transport.callsTo('POST', '/v2/authorizations');
    expect(call.body).toMatchObject({
      amount: 4_500,
      currency: 'GBP',
      instrument_token: 'pmt_visa_4242',
      capture_mode: 'auto',
      soft_descriptor: 'AURORA',
      merchant_reference: 'ch_wf00000001',
    });
  });

  it('sends capture_mode=manual for a manual-capture authorisation', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 200, body: worldflowApproval() }));

    await adapter.authorize({ ...authorizeRequest, captureMethod: 'manual' });

    const [call] = transport.callsTo('POST', '/v2/authorizations');
    expect((call.body as { capture_mode: string }).capture_mode).toBe('manual');
  });

  it('maps an approval onto AuthorizeResult', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 200, body: worldflowApproval() }));

    const result = await adapter.authorize(authorizeRequest);

    expect(result).toMatchObject({
      approved: true,
      networkTransactionId: 'ntx_wf_0001',
      authorizationCode: 'A17742',
      processorReference: 'wf_auth_0001',
      declineCode: null,
      riskScore: 12,
    });
    expect(result.card).toMatchObject({ brand: 'visa', last_four: '4242', funding: 'credit' });
    expect(result.threeDSecure?.liabilityShifted).toBe(true);
  });

  it('normalises the acquirer’s upper-case brand and funding vocabulary', async () => {
    transport.on('POST', '/v2/authorizations', () => ({
      status: 200,
      body: worldflowApproval({
        instrument: {
          brand: 'MASTERCARD',
          last4: '5454',
          exp_month: 4,
          exp_year: 2028,
          issuer_country: 'IE',
          funding: 'DEBIT',
        },
      }),
    }));

    const result = await adapter.authorize(authorizeRequest);

    expect(result.card.brand).toBe('mastercard');
    expect(result.card.funding).toBe('debit');
  });

  it('maps a decline onto a decline code without throwing', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 200, body: worldflowDecline() }));

    const result = await adapter.authorize(authorizeRequest);

    expect(result.approved).toBe(false);
    expect(result.declineCode).toBe('insufficient_funds');
    expect(result.networkTransactionId).toBeNull();
    expect(result.authorizationCode).toBeNull();
  });

  it('turns a 402 decline body into InsufficientFundsException', async () => {
    transport.on('POST', '/v2/authorizations', () => ({
      status: 402,
      body: { decline_code: 'INSUFFICIENT_FUNDS', message: 'insufficient funds' },
    }));

    await expect(adapter.authorize(authorizeRequest)).rejects.toBeInstanceOf(
      InsufficientFundsException,
    );
  });

  it('captures at /v2/authorizations/{ntx}/captures — the arc-INC path', async () => {
    transport.on('POST', '/v2/authorizations/:ntx/captures', () => ({
      status: 200,
      body: {
        status: 'captured',
        reference: 'wf_cap_0001',
        captured_amount: 4_500,
        captured_at: '2026-01-15T12:00:00.000Z',
      },
    }));

    const result = await adapter.capture({
      networkTransactionId: 'ntx_wf_0001',
      amountMinor: 4_500,
      currency: 'GBP',
      idempotencyKey: 'capture:ch_wf00000001',
    });

    const [call] = transport.callsTo('POST', /\/v2\/authorizations\/[^/]+\/captures$/);
    expect(call.path).toBe('/v2/authorizations/ntx_wf_0001/captures');
    expect(call.headers['idempotency-key']).toBe('capture:ch_wf00000001');
    expect(result.capturedAmountMinor).toBe(4_500);
  });

  it('voids at /v2/authorizations/{ntx}/void', async () => {
    transport.on('POST', '/v2/authorizations/:ntx/void', () => ({
      status: 200,
      body: { status: 'voided', reference: 'wf_void_0001' },
    }));

    const result = await adapter.void({
      networkTransactionId: 'ntx_wf_0001',
      idempotencyKey: 'void:ch_wf00000001',
    });

    expect(transport.callsTo('POST', /\/void$/)[0].path).toBe('/v2/authorizations/ntx_wf_0001/void');
    expect(result.voided).toBe(true);
  });

  it('refunds at /v2/refunds', async () => {
    transport.on('POST', '/v2/refunds', () => ({
      status: 200,
      body: { status: 'accepted', reference: 'wf_ref_0001', failure_reason: null },
    }));

    const result = await adapter.refund({
      networkTransactionId: 'ntx_wf_0001',
      amountMinor: 1_500,
      currency: 'GBP',
      reason: 'duplicate',
      idempotencyKey: 'refund:re_0001',
    });

    expect(transport.callsTo('POST', '/v2/refunds')).toHaveLength(1);
    expect(result.refunded).toBe(true);
  });

  it('throws ProcessorUnavailableException on a 503', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 503, body: { message: 'down' } }));

    await expect(adapter.authorize(authorizeRequest)).rejects.toBeInstanceOf(
      ProcessorUnavailableException,
    );
  });

  it('throws ProcessorUnavailableException on a socket reset', async () => {
    transport.on('POST', '/v2/authorizations', () => ({ status: 200, body: worldflowApproval() }));
    transport.failOnce(
      new TransportError('connection_reset', 'http://worldflow.test:9100/v2/authorizations', 'ECONNRESET'),
    );

    await expect(adapter.authorize({ ...authorizeRequest, idempotencyKey: 'auth:reset' })).rejects.toBeInstanceOf(
      ProcessorUnavailableException,
    );
  });

  it('healthCheck GETs /v2/health and reports false on a non-2xx', async () => {
    transport.on('GET', '/v2/health', () => ({ status: 500, body: {} }));
    await expect(adapter.healthCheck()).resolves.toBe(false);

    transport.reset();
    transport.on('GET', '/v2/health', () => ({ status: 200, body: { status: 'ok' } }));
    await expect(adapter.healthCheck()).resolves.toBe(true);
  });

  describe('parseWebhook', () => {
    const body = Buffer.from(
      JSON.stringify({
        event_type: 'chargeback.opened',
        network_transaction_id: 'ntx_wf_0001',
        occurred_at: '2026-01-15T11:59:00.000Z',
      }),
    );

    it('accepts a correctly signed body and maps the acquirer vocabulary', () => {
      const timestamp = Math.floor(clock.nowMs() / 1000);
      const header = signAcquirerWebhook(verifier, 'worldflow', body, timestamp);

      const event = adapter.parseWebhook(body, header);

      expect(event).toMatchObject({
        acquirer: 'worldflow',
        kind: 'dispute_opened',
        networkTransactionId: 'ntx_wf_0001',
      });
    });

    it('rejects a forged signature', () => {
      const timestamp = Math.floor(clock.nowMs() / 1000);

      expect(() => adapter.parseWebhook(body, `t=${timestamp},v1=${'0'.repeat(64)}`)).toThrow();
    });

    it('rejects a signature outside the five-minute tolerance', () => {
      const stale = Math.floor(clock.nowMs() / 1000) - 3_600;
      const header = signAcquirerWebhook(verifier, 'worldflow', body, stale);

      expect(() => adapter.parseWebhook(body, header)).toThrow();
    });
  });
});
