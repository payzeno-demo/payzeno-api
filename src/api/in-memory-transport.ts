/**
 * Route-table transport. Wired only by the `NODE_ENV=test` boot in `ApiModule` and by
 * `test/support/test-app.ts`; it is never reachable in production, and that is on purpose —
 * the e2e suite exercises the real `LedgerHttpClient`, the real retry policy and the real
 * error translation, and only swaps the socket.
 *
 * Deliberately dead in prod. Do not delete it because coverage says nothing calls it.
 */

import { Injectable } from '@nestjs/common';

import {
  TransportError,
  type HttpMethod,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from './transport.interface';

export interface StubResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Simulated latency, so retry/backoff assertions have something to measure. */
  delayMs?: number;
}

export type StubHandler = (req: TransportRequest) => StubResponse | Promise<StubResponse>;

interface Route {
  method: HttpMethod;
  pattern: RegExp;
  handler: StubHandler;
}

export interface RecordedCall {
  method: HttpMethod;
  url: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

@Injectable()
export class InMemoryTransport implements HttpTransport {
  readonly name = 'in-memory' as const;

  private readonly routes: Route[] = [];
  private readonly calls: RecordedCall[] = [];
  private failNextWith: TransportError | null = null;

  /**
   * `pathPattern` is a path template — `/internal/v1/balances/:merchantId` — or a RegExp for
   * the cases a template cannot express.
   */
  on(method: HttpMethod, pathPattern: string | RegExp, handler: StubHandler): this {
    this.routes.push({
      method,
      pattern: pathPattern instanceof RegExp ? pathPattern : templateToRegExp(pathPattern),
      handler,
    });
    return this;
  }

  /** Arms a one-shot socket failure, so retry behaviour can be asserted deterministically. */
  failOnce(error: TransportError): this {
    this.failNextWith = error;
    return this;
  }

  async send(req: TransportRequest): Promise<TransportResponse> {
    const started = Date.now();
    const path = pathOf(req.url);
    this.calls.push({
      method: req.method,
      url: req.url,
      path,
      body: req.body ? safeParse(req.body) : null,
      headers: req.headers,
    });

    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = null;
      throw err;
    }

    const route = this.routes.find((r) => r.method === req.method && r.pattern.test(path));
    if (!route) {
      throw new TransportError('network', req.url, `in-memory transport has no route for ${req.method} ${path}`);
    }

    const stub = await route.handler(req);
    if (stub.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, stub.delayMs));
    }
    return {
      status: stub.status,
      headers: { 'content-type': 'application/json', ...(stub.headers ?? {}) },
      body: stub.body === undefined ? '' : JSON.stringify(stub.body),
      durationMs: Date.now() - started,
    };
  }

  callsTo(method: HttpMethod, pathPattern: string | RegExp): RecordedCall[] {
    const pattern = pathPattern instanceof RegExp ? pathPattern : templateToRegExp(pathPattern);
    return this.calls.filter((c) => c.method === method && pattern.test(c.path));
  }

  get callCount(): number {
    return this.calls.length;
  }

  reset(): void {
    this.routes.length = 0;
    this.calls.length = 0;
    this.failNextWith = null;
  }
}

function templateToRegExp(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\w+/g, '[^/]+');
  return new RegExp(`^${escaped}$`);
}

function pathOf(url: string): string {
  const withoutScheme = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
  const queryAt = withoutScheme.indexOf('?');
  return queryAt === -1 ? withoutScheme : withoutScheme.slice(0, queryAt);
}

function safeParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
