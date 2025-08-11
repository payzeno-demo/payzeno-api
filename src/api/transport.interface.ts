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

