/**
 * The production transport. One undici `Agent` per process, with per-request header and body
 * timeouts so a hung upstream cannot pin a request handler for the default 300s.
 *
 * Nothing above L2 imports undici. That is the point of `HttpTransport`.
 */

import { Injectable, Optional } from '@nestjs/common';
import { Agent, request as undiciRequest } from 'undici';

import {
  classifyTransportError,
  TransportError,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from './transport.interface';

export interface UndiciTransportOptions {
  /** Sockets kept alive per origin. Matches the ECS task's connection budget. */
  connections: number;
  keepAliveTimeoutMs: number;
  keepAliveMaxTimeoutMs: number;
}

export const DEFAULT_UNDICI_OPTIONS: UndiciTransportOptions = {
  connections: 32,
  keepAliveTimeoutMs: 4_000,
  keepAliveMaxTimeoutMs: 60_000,
};

@Injectable()
export class UndiciTransport implements HttpTransport {
  readonly name = 'undici' as const;

  private readonly agent: Agent;

  // Nest constructs this with the defaults; `@Optional()` stops it resolving a provider for them.
  constructor(@Optional() options: UndiciTransportOptions = DEFAULT_UNDICI_OPTIONS) {
    this.agent = new Agent({
      connections: options.connections,
      keepAliveTimeout: options.keepAliveTimeoutMs,
      keepAliveMaxTimeout: options.keepAliveMaxTimeoutMs,
    });
  }

  async send(req: TransportRequest): Promise<TransportResponse> {
    const started = Date.now();
    try {
      const res = await undiciRequest(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body ?? undefined,
        dispatcher: this.agent,
        // undici splits the read budget: headersTimeout covers time-to-first-byte,
        // bodyTimeout covers stalls mid-stream. Both must be bounded or a half-open
        // socket holds the request forever.
        headersTimeout: req.readTimeoutMs,
        bodyTimeout: req.readTimeoutMs,
        connectTimeout: req.connectTimeoutMs,
      } as Parameters<typeof undiciRequest>[1]);

      const body = await res.body.text();
      return {
        status: res.statusCode,
        headers: normaliseHeaders(res.headers),
        body,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      throw classifyTransportError(err, req.url);
    }
  }

  /** Closes the pooled sockets. Called from the Nest shutdown hook in `ApiModule`. */
  async close(): Promise<void> {
    await this.agent.close();
  }

  /**
   * Exposed for the readiness probe: a transport that cannot resolve its own agent is a
   * degraded process, and `/readyz` should say so rather than waiting for the first request.
   */
  assertUsable(): void {
    if (!this.agent) {
      throw new TransportError('network', 'undici', 'undici agent was not constructed');
    }
  }
}

function normaliseHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
