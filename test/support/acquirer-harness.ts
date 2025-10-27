import { CircuitBreakerRegistry } from 'src/api/circuit-breaker';
import { DEFAULT_CLIENT_OPTIONS } from 'src/api/client';
import { InMemoryTransport } from 'src/api/in-memory-transport';
import { IdempotentRetryPolicy, NoRetryPolicy } from 'src/api/retry.policy';
import { NoopLogger } from 'src/common/logging/logger';
import type { Clock } from 'src/common/time/clock';

import { FixedClock } from './fixed-clock';
import { AcquirerHttpClient } from 'src/payments/processor/acquirer-http.client';
import type { AcquirerCredentials } from 'src/payments/processor/acquirer-http.client';
import { ProcessorSignatureVerifier } from 'src/payments/processor/processor-signature.verifier';
import { NordpayAdapter } from 'src/payments/processor/nordpay.adapter';
import { WorldflowAdapter } from 'src/payments/processor/worldflow.adapter';

/**
 * Builds a real `WorldflowAdapter` / `NordpayAdapter` over a real `AcquirerHttpClient`,
 * a real retry policy and a real breaker registry, with only the socket replaced by
 * `InMemoryTransport`.
 *
 * The adapter specs are worth something only because everything between the adapter and
 * the socket is production code — the request mapping, the breaker, the decline
 * translation in `AcquirerHttpClient.mapUpstreamFailure`. Mocking `AcquirerHttpClient`
 * would delete exactly the code the specs are about.
 */

export const WORLDFLOW_CREDENTIALS: AcquirerCredentials = {
  acquirer: 'worldflow',
  baseUrl: 'http://worldflow.test:9100',
  apiKey: 'wf_test_key',
  acquirerAccountId: 'wf-acct-payzeno',
};

export function buildWorldflow(
  transport = new InMemoryTransport(),
  clock: Clock = new FixedClock(),
): AcquirerHarness<WorldflowAdapter> {
  const { http, breakers } = buildAcquirerClient(WORLDFLOW_CREDENTIALS, transport);
  const verifier = new ProcessorSignatureVerifier(WEBHOOK_SECRETS, clock);
  return { adapter: new WorldflowAdapter(http, verifier), transport, http, breakers, verifier };
}

/** Builds the `Payzeno-Acquirer-Signature` header the verifier accepts, for a given body. */
export function signAcquirerWebhook(
  verifier: ProcessorSignatureVerifier,
  acquirer: 'worldflow' | 'nordpay',
  rawBody: Buffer,
  timestamp: number,
): string {
  return `t=${timestamp},v1=${verifier.sign(acquirer, rawBody, timestamp)}`;
}

/** A Worldflow `POST /v2/authorizations` success body, in the acquirer's own shape. */
export function worldflowApproval(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'approved',
    network_transaction_id: 'ntx_wf_0001',
    authorization_code: 'A17742',
    reference: 'wf_auth_0001',
    decline_reason: null,
    risk: { score: 12 },
    instrument: {
      brand: 'VISA',
      last4: '4242',
      exp_month: 11,
      exp_year: 2029,
      issuer_country: 'GB',
      funding: 'CREDIT',
    },
    three_ds: {
      version: '2.2.0',
      flow: 'frictionless',
      outcome: 'authenticated',
      eci: '05',
      liability_shift: true,
    },
    ...overrides,
  };
}

