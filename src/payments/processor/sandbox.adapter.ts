/**
 * The `sk_test_` acquirer.
 *
 * Production code, not a test fixture: `ProcessorRouter.select` routes every principal whose
 * api key is in `test` mode here, so a merchant integrating against Payzeno never touches a
 * real acquirer and never needs a sandbox account of their own. It is dead code in the sense
 * that no *live* traffic reaches it, and that is intentional (blueprint §9.2).
 *
 * Behaviour is driven by the last two digits of the amount so merchants can rehearse declines
 * deterministically — the trigger table is in docs/api/versioning.md.
 */

import { Injectable } from '@nestjs/common';
import type { Acquirer, DeclineCode } from '@payzeno/contracts';

import type { Clock } from '../../common/time/clock';
import type { ProcessorAdapter } from './processor.adapter';
import type {
  AuthorizeRequest,
  AuthorizeResult,
  CaptureRequest,
  CaptureResult,
  ProcessorRefundRequest,
  ProcessorRefundResult,
  ProcessorWebhookEvent,
  VoidRequest,
  VoidResult,
} from './processor.types';

/** amount_minor % 100 → the decline the sandbox produces. Anything else approves. */
const DECLINE_TRIGGERS: Readonly<Record<number, DeclineCode>> = {
  1: 'do_not_honor',
  2: 'insufficient_funds',
  3: 'lost_card',
  4: 'stolen_card',
  5: 'expired_card',
  6: 'incorrect_cvc',
  7: 'processing_error',
  8: 'issuer_unavailable',
  9: 'velocity_exceeded',
  10: 'fraud_suspected',
};

/** amount_minor % 100 === 11 forces an SCA challenge, so merchants can test `requires_action`. */
const CHALLENGE_TRIGGER = 11;

@Injectable()
export class SandboxProcessorAdapter implements ProcessorAdapter {
  /**
   * Reports itself as worldflow: `charge.acquirer` is `not null` and typed `Acquirer`, and a
   * third enum member would leak the sandbox into the settlement projection and into
   * `uq_charge_processor_reference`.
   */
  readonly acquirer: Acquirer = 'worldflow';

  constructor(private readonly clock: Clock) {}

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const trigger = req.amountMinor % 100;
    const declineCode = DECLINE_TRIGGERS[trigger] ?? null;
    const challenge = trigger === CHALLENGE_TRIGGER;
    const reference = `SBX-${req.chargeId.slice(-12)}`;

    return {
      approved: declineCode === null && !challenge,
      pendingAuthentication: challenge,
      // There is no sandbox challenge page: the cardholder goes straight back to the return URL,
      // and the resumed confirm reads the challenge as passed (`getAuthorization`).
      challengeUrl: challenge ? (req.threeDSecure?.returnUrl ?? null) : null,
      networkTransactionId: declineCode ? null : `sbxntid_${req.chargeId.slice(-16)}`,
      authorizationCode: declineCode ? null : sixDigitCode(req.chargeId),
      processorReference: reference,
      declineCode,
      riskScore: declineCode === 'fraud_suspected' ? 92 : 3,
      card: {
        brand: 'visa',
        last_four: '4242',
        exp_month: 12,
        exp_year: this.clock.now().getUTCFullYear() + 2,
        country: 'US',
        funding: 'credit',
      },
      threeDSecure: challenge
        ? {
            version: '2.2.0',
            authenticationFlow: 'challenge',
            result: 'unavailable',
            eci: '07',
            liabilityShifted: false,
          }
        : {
            version: '2.2.0',
            authenticationFlow: 'frictionless',
            result: 'authenticated',
            eci: '05',
            liabilityShifted: true,
          },
      raw: { sandbox: true, trigger },
    };
  }

  /**
   * The sandbox keeps no state, so the only authorisation it is ever asked to read back is a
   * challenge it issued — and a test-mode challenge always passes.
   */
  async getAuthorization(processorReference: string): Promise<AuthorizeResult> {
    const seed = processorReference.replace(/^SBX-/, '');
    return {
      approved: true,
      pendingAuthentication: false,
      challengeUrl: null,
      networkTransactionId: `sbxntid_${seed}`,
      authorizationCode: sixDigitCode(seed),
      processorReference,
      declineCode: null,
      riskScore: 3,
      card: {
        brand: 'visa',
        last_four: '4242',
        exp_month: 12,
        exp_year: this.clock.now().getUTCFullYear() + 2,
        country: 'US',
        funding: 'credit',
      },
      threeDSecure: {
        version: '2.2.0',
        authenticationFlow: 'challenge',
        result: 'authenticated',
        eci: '05',
        liabilityShifted: true,
      },
      raw: { sandbox: true, resumed: true },
    };
  }

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    return {
      captured: true,
      processorReference: `SBXCAP-${req.networkTransactionId.slice(-10)}`,
      capturedAmountMinor: req.amountMinor,
      capturedAt: this.clock.now().toISOString(),
    };
  }

  async void(req: VoidRequest): Promise<VoidResult> {
    return { voided: true, processorReference: `SBXVOID-${req.networkTransactionId.slice(-10)}` };
  }

  async refund(req: ProcessorRefundRequest): Promise<ProcessorRefundResult> {
    // A refund of an amount ending in 99 fails, so merchants can exercise `refund.failed`.
    const fails = req.amountMinor % 100 === 99;
    return {
      refunded: !fails,
      processorReference: `SBXRFND-${req.networkTransactionId.slice(-10)}`,
      failureReason: fails ? 'sandbox_forced_failure' : null,
    };
  }

  parseWebhook(raw: Buffer): ProcessorWebhookEvent {
    const body = JSON.parse(raw.toString('utf8')) as {
      kind: ProcessorWebhookEvent['kind'];
      network_transaction_id: string;
    };
    return {
      acquirer: this.acquirer,
      kind: body.kind,
      networkTransactionId: body.network_transaction_id,
      occurredAt: this.clock.now().toISOString(),
      raw: body as unknown as Record<string, unknown>,
    };
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}

function sixDigitCode(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_000;
  }
  return String(hash).padStart(6, '0');
}
