import { InMemoryTransport } from 'src/api/in-memory-transport';
import {
  adapterSupports,
  SUPPORTED_CURRENCIES_BY_ACQUIRER,
} from 'src/payments/processor/processor.adapter';
import type { ProcessorAdapter } from 'src/payments/processor/processor.adapter';
import type { AuthorizeRequest, CaptureRequest } from 'src/payments/processor/processor.types';
import { SandboxProcessorAdapter } from 'src/payments/processor/sandbox.adapter';

import { buildNordpay, buildWorldflow, worldflowApproval } from 'test/support/acquirer-harness';
import { FixedClock } from 'test/support/fixed-clock';

/**
 * The `ProcessorAdapter` contract, driven over all three concretes.
 *
 * `ProcessorRouter` treats these as interchangeable, so they have to *be* interchangeable
 * at this level or the router is not a router, it is a branch. Acquirer-specific wire
 * details live in the per-adapter specs; this file asserts only what every adapter owes
 * every caller.
 */

interface Case {
  name: string;
  adapter: ProcessorAdapter;
  primeAuthorize: () => void;
  primeCapture: () => void;
  primeVoid: () => void;
  primeRefund: () => void;
  primeHealth: () => void;
}

function buildCases(): Case[] {
  const wfTransport = new InMemoryTransport();
  const wf = buildWorldflow(wfTransport, new FixedClock());

  const npTransport = new InMemoryTransport();
  const np = buildNordpay(npTransport, new FixedClock());

  const nordpayApproval = {
    outcome: 'APPROVED',
    scheme_transaction_id: 'ntx_np_c1',
    auth_code: 'N1',
    reference: 'np_auth_c1',
    refusal_reason: null,
    fraud_score: 6,
    card: {
      scheme: 'VISA',
      last_digits: '0002',
      expiry_month: 4,
      expiry_year: 2028,
      issuer_country_code: 'DE',
      funding_source: 'CREDIT',
    },
    authentication: null,
  };

  return [
    {
      name: 'WorldflowAdapter',
      adapter: wf.adapter,
      primeAuthorize: () =>
        wfTransport.on('POST', '/v2/authorizations', () => ({ status: 200, body: worldflowApproval() })),
      primeCapture: () =>
        wfTransport.on('POST', '/v2/authorizations/:ntx/captures', () => ({
          status: 200,
          body: {
            status: 'captured',
            reference: 'wf_cap_c1',
            captured_amount: 4_500,
            captured_at: '2026-01-15T12:00:00.000Z',
          },
        })),
      primeVoid: () =>
        wfTransport.on('POST', '/v2/authorizations/:ntx/void', () => ({
          status: 200,
          body: { status: 'voided', reference: 'wf_void_c1' },
        })),
      primeRefund: () =>
        wfTransport.on('POST', '/v2/refunds', () => ({
          status: 200,
          body: { status: 'accepted', reference: 'wf_ref_c1', failure_reason: null },
        })),
      primeHealth: () => wfTransport.on('GET', '/v2/health', () => ({ status: 200, body: { status: 'ok' } })),
    },
    {
      name: 'NordpayAdapter',
      adapter: np.adapter,
      primeAuthorize: () =>
        npTransport.on('POST', '/v2/authorizations', () => ({ status: 200, body: nordpayApproval })),
      primeCapture: () =>
        npTransport.on('POST', '/v2/authorizations/:ntx/captures', () => ({
          status: 200,
          body: {
            outcome: 'CAPTURED',
            reference: 'np_cap_c1',
            amount: { value: 4_500, currency: 'EUR' },
            processed_at: '2026-01-15T12:00:00.000Z',
          },
        })),
      primeVoid: () =>
        npTransport.on('POST', '/v2/authorizations/:ntx/void', () => ({
          status: 200,
          body: { outcome: 'VOIDED', reference: 'np_void_c1' },
        })),
      primeRefund: () =>
        npTransport.on('POST', '/v2/refunds', () => ({
          status: 200,
          body: { outcome: 'ACCEPTED', reference: 'np_ref_c1', refusal_reason: null },
        })),
      primeHealth: () => npTransport.on('GET', '/v2/health', () => ({ status: 200, body: { status: 'ok' } })),
    },
    {
      name: 'SandboxProcessorAdapter',
      adapter: new SandboxProcessorAdapter(new FixedClock()),
      primeAuthorize: () => undefined,
      primeCapture: () => undefined,
      primeVoid: () => undefined,
      primeRefund: () => undefined,
      primeHealth: () => undefined,
    },
  ];
}

const authorizeRequest: AuthorizeRequest = {
  chargeId: 'ch_contract00001',
  merchantId: 'mch_contract01',
  amountMinor: 4_500,
  currency: 'EUR',
  paymentMethodToken: 'pmt_visa_4242',
  captureMethod: 'automatic',
  statementDescriptor: 'AURORA',
  threeDSecure: null,
  idempotencyKey: 'auth:ch_contract00001',
};

const captureRequest: CaptureRequest = {
  networkTransactionId: 'ntx_contract01',
  amountMinor: 4_500,
  currency: 'EUR',
  idempotencyKey: 'capture:ch_contract00001',
};

describe('ProcessorAdapter contract', () => {
  describe.each(buildCases())('$name', (c) => {
    it('declares an acquirer from the frozen vocabulary', () => {
      expect(['worldflow', 'nordpay']).toContain(c.adapter.acquirer);
    });

    it('authorizes and returns a non-empty processor reference', async () => {
      c.primeAuthorize();

      const result = await c.adapter.authorize(authorizeRequest);

      expect(result.processorReference).toEqual(expect.any(String));
      expect(result.processorReference.length).toBeGreaterThan(0);
      expect(result.card.last_four).toHaveLength(4);
      expect(result.riskScore).toBeGreaterThanOrEqual(0);
      expect(result.raw).toBeDefined();
    });

    it('nulls the network transaction id and auth code when it does not approve', async () => {
      c.primeAuthorize();

      const result = await c.adapter.authorize(authorizeRequest);

      if (!result.approved) {
        expect(result.networkTransactionId).toBeNull();
        expect(result.authorizationCode).toBeNull();
      } else {
        expect(result.declineCode).toBeNull();
        expect(result.networkTransactionId).not.toBeNull();
      }
    });

    it('captures and reports the captured amount and time', async () => {
      c.primeCapture();

      const result = await c.adapter.capture(captureRequest);

      expect(result.captured).toBe(true);
      expect(result.capturedAmountMinor).toBe(4_500);
      expect(Date.parse(result.capturedAt)).not.toBeNaN();
    });

    it('refunds and reports a null failure reason on success', async () => {
      c.primeRefund();

      const result = await c.adapter.refund({
        networkTransactionId: 'ntx_contract01',
        amountMinor: 1_000,
        currency: 'EUR',
        reason: 'requested_by_customer',
        idempotencyKey: 'refund:re_contract01',
      });

      expect(result.refunded).toBe(true);
      expect(result.failureReason).toBeNull();
    });

  });
});
