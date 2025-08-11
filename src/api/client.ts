/**
 * payzeno-api's own outbound HTTP spine.
 *
 * Every cross-service call this repo makes — payzeno-ledger, payzeno-billing-legacy, the card
 * vault, both acquirers — passes through `BaseHttpClient.request`. That is deliberate: it is
 * the single place that owns timeouts, retry, breaker interaction, correlation-header
 * propagation and error translation, so none of those five things can drift per upstream.
 *
 * Layer L2. It may reach L1 (nothing) and L0 (logger, clock, errors). It must never import a
 * service, a repository or a controller. `eslint-plugin-boundaries` enforces that and
 * `osquash` rejects the PR before the linter gets a chance.
 *
 * See docs/adr/0001-nestjs-module-boundaries.md.
 */

import type { ApiError } from '@payzeno/contracts';

import type { PayzenoLogger } from '../common/logging/logger';
import { getRequestContext } from '../common/logging/request-context';
import type { RetryPolicy } from './retry.policy';
import {
  classifyTransportError,
  TransportError,
  type HttpMethod,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from './transport.interface';

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RequestSpec<TBody = unknown> {
  method: HttpMethod;
  path: string;
  query?: QueryParams;
  body?: TBody;
  headers?: Record<string, string>;
  timeoutMs?: number;
  idempotencyKey?: string;
}

export interface ApiClientOptions {
  connectTimeoutMs: number;
  readTimeoutMs: number;
  retries: number;
  retryOn: ReadonlyArray<number>;
  userAgent: string;
}

/** What a subclass gets handed when the upstream answered with a non-2xx. */
export interface UpstreamFailure {
  status: number;
  headers: Record<string, string>;
  rawBody: string;
  /** Parsed `ApiError` envelope when the body is one, otherwise null. */
  apiError: ApiError | null;
  spec: RequestSpec<unknown>;
  url: string;
}

export const DEFAULT_CLIENT_OPTIONS: ApiClientOptions = {
  connectTimeoutMs: 2_000,
  readTimeoutMs: 10_000,
  retries: 2,
  retryOn: [502, 503, 504],
  userAgent: 'payzeno-api',
};

export abstract class BaseHttpClient {
  protected constructor(
    protected readonly transport: HttpTransport,
    protected readonly options: ApiClientOptions,
    protected readonly retryPolicy: RetryPolicy,
    protected readonly logger: PayzenoLogger,
  ) {}

  /** Absolute base, no trailing slash. Comes from `ApiConfig`, never from `process.env`. */
  protected abstract get baseUrl(): string;

  /** Short upstream name — used for logs, metrics and the circuit-breaker registry key. */
  protected abstract get upstream(): string;

  /** Auth and any upstream-specific constants. Merged under per-request headers. */
  protected abstract defaultHeaders(): Record<string, string>;

  /**
   * Translate a non-2xx into this repo's exception hierarchy. Every subclass throws; the
   * return type is `never` so a subclass that forgets to throw fails to compile.
   */
  protected get<TResponse>(path: string, query?: QueryParams, timeoutMs?: number): Promise<TResponse> {
    return this.request<TResponse>({ method: 'GET', path, query, timeoutMs });
  }

  private buildTransportRequest(spec: RequestSpec<unknown>, url: string): TransportRequest {
    const ctx = getRequestContext();
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.options.userAgent,
      ...this.defaultHeaders(),
      ...(spec.headers ?? {}),
    };
    if (ctx?.requestId) {
      headers['x-request-id'] = ctx.requestId;
    }
    if (ctx?.correlationId) {
      // events.ts requires correlation_id to be propagated from the originating request.
      headers['x-correlation-id'] = ctx.correlationId;
    }
    if (spec.idempotencyKey) {
      headers['idempotency-key'] = spec.idempotencyKey;
    }
    let body: string | null = null;
    if (spec.body !== undefined && spec.method !== 'GET') {
      body = JSON.stringify(spec.body);
      headers['content-type'] = 'application/json';
    }
    return {
      method: spec.method,
      url,
      headers,
      body,
      connectTimeoutMs: this.options.connectTimeoutMs,
      readTimeoutMs: spec.timeoutMs ?? this.options.readTimeoutMs,
    };
  }

  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/**
 * The `ApiError` envelope is contracted for every Payzeno HTTP surface (types.ts). Parsing it
 * here — once — is what lets `LedgerHttpClient` pass the ledger's `code`, `httpStatus` and
 * `details` through verbatim instead of collapsing everything into a 502.
 */
export function parseApiError(rawBody: string): ApiError | null {
  if (!rawBody) {
    return null;
  }
  try {
    const parsed = JSON.parse(rawBody) as Partial<ApiError>;
    if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error.code === 'string') {
      return parsed as ApiError;
    }
    return null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
