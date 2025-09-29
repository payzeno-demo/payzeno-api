/**
 * The acquirer transport client. One instance per acquirer, constructed by `PaymentsModule`
 * from `ApiConfig` — `WorldflowAdapter` gets the `:9100` instance, `NordpayAdapter` the
 * `:9101` one (api-surface.md §1.1).
 *
 * Frame 7 of the deepest chain in the repo: controller → service → flow → capture service →
 * router → adapter → **here** → BaseHttpClient.request → UndiciTransport.send.
 */

import type { Acquirer } from '@payzeno/contracts';

import { BaseHttpClient, type ApiClientOptions, type QueryParams, type RequestSpec, type UpstreamFailure } from '../../api/client';
import { CircuitBreakerRegistry } from '../../api/circuit-breaker';
import type { RetryPolicy } from '../../api/retry.policy';
import type { HttpTransport, TransportError } from '../../api/transport.interface';
import type { PayzenoLogger } from '../../common/logging/logger';
import { CardDeclinedException, ExpiredCardException, InsufficientFundsException } from '../../common/errors/card.exceptions';
import { ProcessorUnavailableException } from '../../common/errors/upstream.exceptions';
import { mapDeclineCode } from './processor.types';

export interface AcquirerCredentials {
  acquirer: Acquirer;
  baseUrl: string;
  apiKey: string;
  /** The acquirer's own id for the Payzeno platform account. Sent on every call. */
  acquirerAccountId: string;
}

/**
 * Acquirer error bodies are not `ApiError` — they are the acquirer's own shape. Only these
 * three fields are consumed; everything else rides along in `raw` for the audit log.
 */
interface AcquirerErrorBody {
  error_code?: string;
  decline_code?: string;
  message?: string;
}

export class AcquirerHttpClient extends BaseHttpClient {
  constructor(
    private readonly credentials: AcquirerCredentials,
    transport: HttpTransport,
    options: ApiClientOptions,
    retryPolicy: RetryPolicy,
    logger: PayzenoLogger,
    private readonly breakers: CircuitBreakerRegistry,
  ) {
    super(transport, options, retryPolicy, logger);
  }

  protected get baseUrl(): string {
    return this.credentials.baseUrl;
  }

  protected get upstream(): string {
    return this.credentials.acquirer;
  }

  protected defaultHeaders(): Record<string, string> {
    return {
      authorization: `Bearer ${this.credentials.apiKey}`,
      'payzeno-acquirer-account': this.credentials.acquirerAccountId,
    };
  }

  /**
   * Every acquirer call runs under the acquirer's circuit. An open circuit is a
   * `ProcessorUnavailableException` (502 `processor_unavailable`) — never a raw opossum error,
   * which the exception filter would map to `500 internal_error` and burn the error budget on.
   */
  async call<TResponse, TBody = unknown>(spec: RequestSpec<TBody>): Promise<TResponse> {
    return this.breakers.run(
      `acquirer:${this.credentials.acquirer}`,
      () => this.request<TResponse, TBody>(spec),
      () =>
        new ProcessorUnavailableException(
          `${this.credentials.acquirer} circuit is open`,
          this.credentials.acquirer,
        ),
    );
  }

  postJson<TResponse, TBody>(path: string, body: TBody, idempotencyKey: string): Promise<TResponse> {
    return this.call<TResponse, TBody>({ method: 'POST', path, body, idempotencyKey });
  }

  getJson<TResponse>(path: string, query?: QueryParams): Promise<TResponse> {
    return this.call<TResponse>({ method: 'GET', path, query });
  }

  /**
   * A decline is a 402 from the acquirer and a business outcome, not an outage — it must not
   * count against the breaker, so `AcquirerHttpClient` throws it and opossum sees a rejected
   * promise only for real faults. `ChargeAuthorizationService` catches these.
   */
  protected mapUpstreamFailure(failure: UpstreamFailure): never {
    const body = parseAcquirerError(failure.rawBody);

    if (failure.status === 402 || body.decline_code) {
      const code = mapDeclineCode(body.decline_code ?? body.error_code);
      const message = body.message ?? 'The card was declined';
      if (code === 'insufficient_funds') {
        throw new InsufficientFundsException(message, code);
      }
      if (code === 'expired_card') {
        throw new ExpiredCardException(message, code);
      }
      throw new CardDeclinedException(message, code);
    }

    throw new ProcessorUnavailableException(
      `${this.credentials.acquirer} responded ${failure.status} for ${failure.spec.method} ${failure.spec.path}`,
      this.credentials.acquirer,
      { status: failure.status, error_code: body.error_code ?? null },
    );
  }

  protected mapTransportFailure(err: TransportError, spec: RequestSpec<unknown>): never {
    throw new ProcessorUnavailableException(
      `${this.credentials.acquirer} ${err.kind} on ${spec.method} ${spec.path}`,
      this.credentials.acquirer,
      { failure: err.kind },
    );
  }
}

function parseAcquirerError(raw: string): AcquirerErrorBody {
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as AcquirerErrorBody;
  } catch {
    return { message: raw.slice(0, 200) };
  }
}
