/**
 * The socket seam.
 *
 * `BaseHttpClient` owns policy — timeouts, retries, breakers, error translation. It owns no
 * sockets. Everything below this interface is transport; everything above it is policy. The
 * e2e suite swaps `UndiciTransport` for `InMemoryTransport` and gets the whole ledger surface
 * without stubbing fourteen client methods.
 *
 * See docs/adr/0001-nestjs-module-boundaries.md — L2 (transport) is the lowest layer any
 * outbound call is allowed to reach.
 */

/** Injection token. `ApiModule` binds it to `UndiciTransport`, or `InMemoryTransport` under NODE_ENV=test. */
export const HTTP_TRANSPORT = Symbol('HTTP_TRANSPORT');

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface TransportRequest {
  method: HttpMethod;
  /** Fully-resolved absolute URL, query string already encoded. */
  url: string;
  headers: Record<string, string>;
  /** Already-serialised body, or null for bodyless verbs. */
  body: string | null;
  connectTimeoutMs: number;
  readTimeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  /** Raw response body. Parsing is the client's business, not the transport's. */
  body: string;
  durationMs: number;
}

/**
 * The failure kinds `RetryPolicy` and `LedgerHttpClient` discriminate on.
 *
 * `connect_timeout` / `read_timeout` matter separately because a read timeout means the
 * request was almost certainly delivered — retrying it is only safe when the call carries an
 * idempotency key. api-surface.md §11 spells the predicate out.
 */
export type TransportFailureKind =
  | 'connect_timeout'
  | 'read_timeout'
  | 'connection_reset'
  | 'dns_failure'
  | 'network';

export class TransportError extends Error {
  constructor(
    readonly kind: TransportFailureKind,
    readonly url: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransportError';
  }

  /** True when the request certainly never reached the upstream, so a replay is free. */
  get definitelyNotDelivered(): boolean {
    return this.kind === 'connect_timeout' || this.kind === 'dns_failure';
  }
}

export interface HttpTransport {
  readonly name: 'undici' | 'in-memory';
  send(req: TransportRequest): Promise<TransportResponse>;
}

/** Node error codes we recognise, mapped onto the kinds above. */
export const TRANSPORT_ERROR_CODES: Readonly<Record<string, TransportFailureKind>> = {
  UND_ERR_CONNECT_TIMEOUT: 'connect_timeout',
  UND_ERR_HEADERS_TIMEOUT: 'read_timeout',
  UND_ERR_BODY_TIMEOUT: 'read_timeout',
  UND_ERR_SOCKET: 'connection_reset',
  ECONNRESET: 'connection_reset',
  ECONNREFUSED: 'network',
  EPIPE: 'connection_reset',
  ETIMEDOUT: 'read_timeout',
  ENOTFOUND: 'dns_failure',
  EAI_AGAIN: 'dns_failure',
};

export function classifyTransportError(err: unknown, url: string): TransportError {
  if (err instanceof TransportError) {
    return err;
  }
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : '';
  const kind = TRANSPORT_ERROR_CODES[code] ?? 'network';
  const message = err instanceof Error ? err.message : String(err);
  return new TransportError(kind, url, `${kind}: ${message}`, err);
}
