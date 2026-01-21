/**
 * payzeno-api → payzeno-billing-legacy (api-surface.md §13).
 *
 * Spring Boot, `/internal/v1`, Basic auth over the internal network. Every call runs under an
 * opossum circuit (50% error threshold over 20 requests, 30s reset); a trip is
 * `LegacyBillingUnavailableException` → `502 legacy_upstream_unavailable`.
 *
 * ### arc MIG
 *
 * `generateInvoice`, `computeFees` and `getStatement` map to `@Deprecated` Java handlers. They
 * still work, they still have callers inside payzeno-billing-legacy's own scheduled jobs, and
 * calling them from payzeno-api logs `LEGACY_CALL_AFTER_MIGRATION` at WARN. That log line is
 * the visible surface of the strangler: grep production for it and you get the exact list of
 * what has not moved yet.
 *
 * TODO(PAY-1843): `computeFees` goes away at step 4 — the ledger owns fees behind
 * `ledger_owns_fees` (on since month 6) and this method is only reachable from the statement
 * renderer, which nobody has ported. `getStatement` goes with it.
 */

import { Injectable } from '@nestjs/common';
import type { Invoice, InvoiceListResponse, InvoiceStatus, MerchantId } from '@payzeno/contracts';

import { BaseHttpClient, type ApiClientOptions, type RequestSpec, type UpstreamFailure } from '../api/client';
import { CircuitBreakerRegistry, type BreakerOptions } from '../api/circuit-breaker';
import type { RetryPolicy } from '../api/retry.policy';
import type { HttpTransport, TransportError } from '../api/transport.interface';
import type { BillingLegacyConfig } from '../config/api-config.type';
import { LegacyBillingUnavailableException } from '../common/errors/upstream.exceptions';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import type { PayzenoLogger } from '../common/logging/logger';

export const BILLING_LEGACY_CIRCUIT = 'billing-legacy';

export interface InvoiceListFilter {
  status?: InvoiceStatus;
  cursor?: string;
  limit?: number;
}

export interface GenerateInvoiceRequest {
  merchant_id: MerchantId;
  period_start: string;
  period_end: string;
  currency: string;
}

export interface ComputeFeesRequest {
  merchant_id: MerchantId;
  currency: string;
  gross_minor: number;
  card_brand: string;
  card_funding: string;
}

export interface ComputeFeesResponse {
  fee_minor: number;
  interchange_minor: number;
  scheme_fee_minor: number;
}

export interface LegacyStatement {
  merchant_id: MerchantId;
  period: string;
  opening_balance_minor: number;
  closing_balance_minor: number;
  lines: Array<{ description: string; amount_minor: number }>;
}

export interface LegacySubscription {
  id: string;
  merchant_id: MerchantId;
  plan_code: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
}

@Injectable()
export class BillingLegacyClient extends BaseHttpClient {
  constructor(
    private readonly billingConfig: BillingLegacyConfig,
    transport: HttpTransport,
    options: ApiClientOptions,
    retryPolicy: RetryPolicy,
    logger: PayzenoLogger,
    private readonly breakers: CircuitBreakerRegistry,
  ) {
    super(transport, options, retryPolicy, logger);
  }

  protected get baseUrl(): string {
    return this.billingConfig.baseUrl;
  }

  protected get upstream(): string {
    return 'payzeno-billing-legacy';
  }

  protected defaultHeaders(): Record<string, string> {
    const basic = Buffer.from(`${this.billingConfig.user}:${this.billingConfig.password}`).toString('base64');
    return { authorization: `Basic ${basic}` };
  }

  // -- live surface --------------------------------------------------------

  /** @deprecated migrating to the ledger — arc MIG step 4. `InvoiceController#generate`. */
  generateInvoice(req: GenerateInvoiceRequest): Promise<Invoice> {
    this.warnLegacyCall('generateInvoice', req.merchant_id);
    return this.guarded(() =>
      this.request<Invoice, GenerateInvoiceRequest>({
        method: 'POST',
        path: '/internal/v1/invoices',
        body: req,
        idempotencyKey: `invoice_generate:${req.merchant_id}:${req.period_start}`,
      }),
    );
  }

  protected mapUpstreamFailure(failure: UpstreamFailure): never {
    if (failure.status === 404) {
      throw new ResourceNotFoundException('invoice', failure.spec.path);
    }
    // The Java service answers with its own error shape, not `ApiError`. Anything non-2xx that
    // is not a 404 is an upstream problem as far as the merchant is concerned.
    throw new LegacyBillingUnavailableException(
      `payzeno-billing-legacy responded ${failure.status} for ${failure.spec.method} ${failure.spec.path}`,
      { status: failure.status },
    );
  }

  protected mapTransportFailure(err: TransportError, spec: RequestSpec<unknown>): never {
    throw new LegacyBillingUnavailableException(
      `payzeno-billing-legacy ${err.kind} on ${spec.method} ${spec.path}`,
      { failure: err.kind },
    );
  }
}
