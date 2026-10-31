/**
 * Nordpay — the EEA acquirer. Same route shape as Worldflow (api-surface.md §15), different
 * base URL and a slightly different response vocabulary: Nordpay is a 3DS-first acquirer and
 * returns the authentication block on every EUR/GBP e-commerce authorisation, not only on a
 * challenge.
 *
 * EUR and GBP only — `SUPPORTED_CURRENCIES_BY_ACQUIRER` in processor.adapter.ts.
 */

import { Injectable } from '@nestjs/common';
import type { Acquirer, CardBrand, CardFunding } from '@payzeno/contracts';

import { ProcessorUnavailableException } from '../../common/errors/upstream.exceptions';
import type { AcquirerHttpClient } from './acquirer-http.client';
import type { ProcessorAdapter } from './processor.adapter';
import { ProcessorSignatureVerifier } from './processor-signature.verifier';
import {
  mapDeclineCode,
  type AuthorizeRequest,
  type AuthorizeResult,
  type CaptureRequest,
  type CaptureResult,
  type ProcessorRefundRequest,
  type ProcessorRefundResult,
  type ProcessorWebhookEvent,
  type ProcessorWebhookKind,
  type VoidRequest,
  type VoidResult,
} from './processor.types';

interface NordpayAuthorizationResponse {
  outcome: 'APPROVED' | 'DECLINED' | 'AUTHENTICATION_REQUIRED';
  scheme_transaction_id: string | null;
  auth_code: string | null;
  reference: string;
  refusal_reason: string | null;
  fraud_score: number;
  card: {
    scheme: string;
    last_digits: string;
    expiry_month: number;
    expiry_year: number;
    issuer_country_code: string | null;
    funding_source: string;
  };
  authentication: {
    protocol_version: string;
    flow: 'frictionless' | 'challenge';
    status: 'Y' | 'A' | 'N' | 'U';
    eci: string;
    liability_shift: boolean;
    /** Present while `outcome` is `AUTHENTICATION_REQUIRED`. */
    challenge_url?: string;
  } | null;
  /** Same page as `authentication.challenge_url`; older sandbox builds only send this one. */
  redirect_url?: string;
}

interface NordpayCaptureResponse {
  outcome: 'CAPTURED' | 'PENDING';
  reference: string;
  amount: { value: number; currency: string };
  processed_at: string;
}

interface NordpayVoidResponse {
  outcome: 'VOIDED' | 'NOT_FOUND';
  reference: string;
}

interface NordpayRefundResponse {
  outcome: 'ACCEPTED' | 'REFUSED';
  reference: string;
  refusal_reason: string | null;
}

interface NordpayWebhookBody {
  notification_type: string;
  scheme_transaction_id: string;
  event_time: string;
  [key: string]: unknown;
}

const WEBHOOK_KIND_BY_NOTIFICATION: Readonly<Record<string, ProcessorWebhookKind>> = {
  DISPUTE_RAISED: 'dispute_opened',
  DISPUTE_RESOLVED: 'dispute_closed',
  DISPUTE_WITHDRAWN: 'chargeback_reversed',
  CAPTURE_SETTLED: 'capture_settled',
  REFUND_SETTLED: 'refund_settled',
};

/** Nordpay reports 3DS with the scheme's raw transStatus letters. */
const AUTHENTICATION_RESULT_BY_STATUS: Readonly<
  Record<'Y' | 'A' | 'N' | 'U', 'authenticated' | 'attempted' | 'failed' | 'unavailable'>
> = {
  Y: 'authenticated',
  A: 'attempted',
  N: 'failed',
  U: 'unavailable',
};

@Injectable()
export class NordpayAdapter implements ProcessorAdapter {
  readonly acquirer: Acquirer = 'nordpay';

  constructor(
    private readonly http: AcquirerHttpClient,
    private readonly verifier: ProcessorSignatureVerifier,
  ) {}

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const res = await this.http.postJson<NordpayAuthorizationResponse, unknown>(
      '/v2/authorizations',
      {
        amount: { value: req.amountMinor, currency: req.currency },
        instrument_token: req.paymentMethodToken,
        capture_mode: req.captureMethod === 'automatic' ? 'AUTOMATIC' : 'MANUAL',
        soft_descriptor: req.statementDescriptor,
        merchant_reference: req.chargeId,
        authentication: req.threeDSecure
          ? {
              return_url: req.threeDSecure.returnUrl,
              challenge_preference: req.threeDSecure.challengePreference === 'force' ? 'FORCE' : 'AUTO',
            }
          : undefined,
      },
      req.idempotencyKey,
    );

    return toAuthorizeResult(res);
  }

  async getAuthorization(processorReference: string): Promise<AuthorizeResult> {
    const res = await this.http.getJson<NordpayAuthorizationResponse>(
      `/v2/authorizations/${encodeURIComponent(processorReference)}`,
    );
    return toAuthorizeResult(res);
  }

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    const res = await this.http.postJson<NordpayCaptureResponse, unknown>(
      `/v2/authorizations/${encodeURIComponent(req.networkTransactionId)}/captures`,
      { amount: { value: req.amountMinor, currency: req.currency } },
      req.idempotencyKey,
    );
    return {
      captured: res.outcome === 'CAPTURED',
      processorReference: res.reference,
      capturedAmountMinor: res.amount.value,
      capturedAt: res.processed_at,
    };
  }

  async void(req: VoidRequest): Promise<VoidResult> {
    const res = await this.http.postJson<NordpayVoidResponse, unknown>(
      `/v2/authorizations/${encodeURIComponent(req.networkTransactionId)}/void`,
      {},
      req.idempotencyKey,
    );
    if (res.outcome === 'NOT_FOUND') {
      // Nordpay expires holds itself after 7 days and then forgets them. Treat it as voided:
      // the money is not held, which is the property the caller needs.
      return { voided: true, processorReference: res.reference };
    }
    return { voided: true, processorReference: res.reference };
  }

  async refund(req: ProcessorRefundRequest): Promise<ProcessorRefundResult> {
    const res = await this.http.postJson<NordpayRefundResponse, unknown>(
      '/v2/refunds',
      {
        scheme_transaction_id: req.networkTransactionId,
        amount: { value: req.amountMinor, currency: req.currency },
        reason_code: req.reason,
      },
      req.idempotencyKey,
    );
    return {
      refunded: res.outcome === 'ACCEPTED',
      processorReference: res.reference,
      failureReason: res.refusal_reason,
    };
  }

  parseWebhook(raw: Buffer, signature: string): ProcessorWebhookEvent {
    this.verifier.assertValid(this.acquirer, raw, signature);
    const body = JSON.parse(raw.toString('utf8')) as NordpayWebhookBody;
    const kind = WEBHOOK_KIND_BY_NOTIFICATION[body.notification_type];
    if (!kind) {
      throw new ProcessorUnavailableException(
        `nordpay sent an unknown notification '${body.notification_type}'`,
        this.acquirer,
      );
    }
    return {
      acquirer: this.acquirer,
      kind,
      networkTransactionId: body.scheme_transaction_id,
      occurredAt: body.event_time,
      raw: body,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.http.getJson<{ status: string }>('/v2/health');
      return true;
    } catch {
      return false;
    }
  }
}

/** One mapping for both reads — the authorize response and `GET /v2/authorizations/{id}`. */
function toAuthorizeResult(res: NordpayAuthorizationResponse): AuthorizeResult {
  const pending = res.outcome === 'AUTHENTICATION_REQUIRED';
  return {
    approved: res.outcome === 'APPROVED',
    pendingAuthentication: pending,
    challengeUrl: pending ? (res.authentication?.challenge_url ?? res.redirect_url ?? null) : null,
    networkTransactionId: res.scheme_transaction_id,
    authorizationCode: res.auth_code,
    processorReference: res.reference,
    declineCode: res.outcome === 'DECLINED' ? mapDeclineCode(res.refusal_reason) : null,
    riskScore: res.fraud_score ?? 0,
    card: {
      brand: normaliseScheme(res.card.scheme),
      last_four: res.card.last_digits,
      exp_month: res.card.expiry_month,
      exp_year: res.card.expiry_year,
      country: res.card.issuer_country_code,
      funding: normaliseFundingSource(res.card.funding_source),
    },
    threeDSecure: res.authentication
      ? {
          version: res.authentication.protocol_version,
          authenticationFlow: res.authentication.flow,
          result: AUTHENTICATION_RESULT_BY_STATUS[res.authentication.status],
          eci: res.authentication.eci,
          liabilityShifted: res.authentication.liability_shift,
        }
      : null,
    raw: res as unknown as Record<string, unknown>,
  };
}

function normaliseScheme(raw: string): CardBrand {
  switch (raw.toLowerCase()) {
    case 'visa':
      return 'visa';
    case 'mc':
    case 'mastercard':
      return 'mastercard';
    case 'amex':
      return 'amex';
    case 'discover':
    case 'diners':
      return 'discover';
    default:
      return 'visa';
  }
}

function normaliseFundingSource(raw: string): CardFunding {
  switch (raw.toLowerCase()) {
    case 'credit':
      return 'credit';
    case 'debit':
      return 'debit';
    case 'prepaid':
      return 'prepaid';
    default:
      return 'unknown';
  }
}
