/**
 * Worldflow — the default acquirer, and the one the INC arc's deferred captures go through.
 * Route shape is api-surface.md §15, shared with Nordpay; only the base URL differs.
 *
 * L3. Talks to L2 (`AcquirerHttpClient`) and to nothing above itself.
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

interface WorldflowAuthorizationResponse {
  status: 'approved' | 'declined' | 'pending_authentication';
  network_transaction_id: string | null;
  authorization_code: string | null;
  reference: string;
  decline_reason: string | null;
  risk: { score: number };
  instrument: {
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
    issuer_country: string | null;
    funding: string;
  };
  three_ds?: {
    version: string;
    flow: 'frictionless' | 'challenge';
    outcome: 'authenticated' | 'attempted' | 'failed' | 'unavailable';
    eci: string;
    liability_shift: boolean;
    /** Present while `status` is `pending_authentication`. */
    challenge_url?: string;
  };
  /** Same page as `three_ds.challenge_url`; older sandbox builds only send this one. */
  redirect_url?: string;
}

interface WorldflowCaptureResponse {
  status: 'captured' | 'pending';
  reference: string;
  captured_amount: number;
  captured_at: string;
}

interface WorldflowVoidResponse {
  status: 'voided' | 'already_voided';
  reference: string;
}

interface WorldflowRefundResponse {
  status: 'accepted' | 'rejected';
  reference: string;
  reject_reason: string | null;
}

interface WorldflowWebhookBody {
  event: string;
  network_transaction_id: string;
  occurred_at: string;
  [key: string]: unknown;
}

const WEBHOOK_KIND_BY_EVENT: Readonly<Record<string, ProcessorWebhookKind>> = {
  'chargeback.opened': 'dispute_opened',
  'chargeback.closed': 'dispute_closed',
  'chargeback.reversed': 'chargeback_reversed',
  'capture.settled': 'capture_settled',
  'refund.settled': 'refund_settled',
};

@Injectable()
export class WorldflowAdapter implements ProcessorAdapter {
  readonly acquirer: Acquirer = 'worldflow';

  constructor(
    private readonly http: AcquirerHttpClient,
    private readonly verifier: ProcessorSignatureVerifier,
  ) {}

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const res = await this.http.postJson<WorldflowAuthorizationResponse, unknown>(
      '/v2/authorizations',
      {
        amount: req.amountMinor,
        currency: req.currency,
        instrument_token: req.paymentMethodToken,
        capture_mode: req.captureMethod === 'automatic' ? 'auto' : 'manual',
        soft_descriptor: req.statementDescriptor,
        merchant_reference: req.chargeId,
        three_ds: req.threeDSecure
          ? { return_url: req.threeDSecure.returnUrl, preference: req.threeDSecure.challengePreference }
          : undefined,
      },
      req.idempotencyKey,
    );

    return toAuthorizeResult(res);
  }

  async getAuthorization(processorReference: string): Promise<AuthorizeResult> {
    const res = await this.http.getJson<WorldflowAuthorizationResponse>(
      `/v2/authorizations/${encodeURIComponent(processorReference)}`,
    );
    return toAuthorizeResult(res);
  }

  async capture(req: CaptureRequest): Promise<CaptureResult> {
    const res = await this.http.postJson<WorldflowCaptureResponse, unknown>(
      `/v2/authorizations/${encodeURIComponent(req.networkTransactionId)}/captures`,
      { amount: req.amountMinor, currency: req.currency },
      req.idempotencyKey,
    );
    return {
      captured: res.status === 'captured',
      processorReference: res.reference,
      capturedAmountMinor: res.captured_amount,
      capturedAt: res.captured_at,
    };
  }

  async void(req: VoidRequest): Promise<VoidResult> {
    const res = await this.http.postJson<WorldflowVoidResponse, unknown>(
      `/v2/authorizations/${encodeURIComponent(req.networkTransactionId)}/void`,
      {},
      req.idempotencyKey,
    );
    // `already_voided` is a success: the hold is gone, which is all the caller wanted.
    return { voided: res.status === 'voided' || res.status === 'already_voided', processorReference: res.reference };
  }

  async refund(req: ProcessorRefundRequest): Promise<ProcessorRefundResult> {
    const res = await this.http.postJson<WorldflowRefundResponse, unknown>(
      '/v2/refunds',
      {
        network_transaction_id: req.networkTransactionId,
        amount: req.amountMinor,
        currency: req.currency,
        reason: req.reason,
      },
      req.idempotencyKey,
    );
    return {
      refunded: res.status === 'accepted',
      processorReference: res.reference,
      failureReason: res.reject_reason,
    };
  }

  parseWebhook(raw: Buffer, signature: string): ProcessorWebhookEvent {
    this.verifier.assertValid(this.acquirer, raw, signature);
    const body = JSON.parse(raw.toString('utf8')) as WorldflowWebhookBody;
    const kind = WEBHOOK_KIND_BY_EVENT[body.event];
    if (!kind) {
      throw new ProcessorUnavailableException(
        `worldflow sent an unknown webhook event '${body.event}'`,
        this.acquirer,
      );
    }
    return {
      acquirer: this.acquirer,
      kind,
      networkTransactionId: body.network_transaction_id,
      occurredAt: body.occurred_at,
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
function toAuthorizeResult(res: WorldflowAuthorizationResponse): AuthorizeResult {
  const pending = res.status === 'pending_authentication';
  return {
    approved: res.status === 'approved',
    pendingAuthentication: pending,
    challengeUrl: pending ? (res.three_ds?.challenge_url ?? res.redirect_url ?? null) : null,
    networkTransactionId: res.network_transaction_id,
    authorizationCode: res.authorization_code,
    processorReference: res.reference,
    declineCode: res.status === 'declined' ? mapDeclineCode(res.decline_reason) : null,
    riskScore: res.risk?.score ?? 0,
    card: {
      brand: normaliseBrand(res.instrument.brand),
      last_four: res.instrument.last4,
      exp_month: res.instrument.exp_month,
      exp_year: res.instrument.exp_year,
      country: res.instrument.issuer_country,
      funding: normaliseFunding(res.instrument.funding),
    },
    threeDSecure: res.three_ds
      ? {
          version: res.three_ds.version,
          authenticationFlow: res.three_ds.flow,
          result: res.three_ds.outcome,
          eci: res.three_ds.eci,
          liabilityShifted: res.three_ds.liability_shift,
        }
      : null,
    raw: res as unknown as Record<string, unknown>,
  };
}

function normaliseBrand(raw: string): CardBrand {
  const lower = raw.toLowerCase();
  if (lower === 'visa' || lower === 'mastercard' || lower === 'amex' || lower === 'discover') {
    return lower;
  }
  // Worldflow spells American Express two ways depending on the scheme file vintage.
  if (lower === 'american_express' || lower === 'amex_us') {
    return 'amex';
  }
  return 'visa';
}

function normaliseFunding(raw: string): CardFunding {
  const lower = raw.toLowerCase();
  if (lower === 'credit' || lower === 'debit' || lower === 'prepaid') {
    return lower;
  }
  return 'unknown';
}
