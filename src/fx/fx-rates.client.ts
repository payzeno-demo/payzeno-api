/**
 * L3. The FX rates vendor — `GET {FX_PROVIDER_URL}/v1/rates?base=USD`. RFC platform-v2 §7.
 *
 *   {"base":"USD","as_of":"2026-10-29T08:00:00Z","rates":{"EUR":"0.9231","JPY":"152.10",…}}
 *
 * Mid-rates as decimal strings, per one unit of `base`. A vendor in production, sim-world's
 * simulated feed locally. Short timeouts and no retries: the caller is a checkout page load,
 * and `FxService` fails closed (no currency options) rather than make a shopper wait.
 */
import type { RequestSpec, UpstreamFailure } from '../api/client';
import { BaseHttpClient, type ApiClientOptions } from '../api/client';
import type { RetryPolicy } from '../api/retry.policy';
import type { HttpTransport, TransportError } from '../api/transport.interface';
import { UpstreamException } from '../common/errors/upstream.exceptions';
import type { PayzenoLogger } from '../common/logging/logger';

export interface FxRatesResponse {
  base: string;
  as_of: string;
  rates: Record<string, string>;
}

export class FxRatesClient extends BaseHttpClient {
  constructor(
    private readonly providerUrl: string,
    transport: HttpTransport,
    options: ApiClientOptions,
    retryPolicy: RetryPolicy,
    logger: PayzenoLogger,
  ) {
    super(transport, options, retryPolicy, logger);
  }

  protected get baseUrl(): string {
    return this.providerUrl;
  }

  protected get upstream(): string {
    return 'fx-provider';
  }

  protected defaultHeaders(): Record<string, string> {
    return { accept: 'application/json' };
  }

  latest(base: string): Promise<FxRatesResponse> {
    return this.get<FxRatesResponse>('/v1/rates', { base });
  }

  protected mapUpstreamFailure(failure: UpstreamFailure): never {
    throw new UpstreamException('fx-provider', `FX provider responded ${failure.status}`, {
      status: failure.status,
    });
  }

  protected mapTransportFailure(err: TransportError, spec: RequestSpec<unknown>): never {
    throw new UpstreamException('fx-provider', `FX provider ${err.kind} on ${spec.method} ${spec.path}`, {
      failure: err.kind,
    });
  }
}
