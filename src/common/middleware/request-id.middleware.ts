/**
 * First link in the chain (api-surface.md §1.5).
 *
 * Mints or echoes `X-Request-Id` and opens the AsyncLocalStorage context every downstream
 * frame reads. Everything after this point — the logger, the audit interceptor, the outbox
 * publisher, HttpExceptionFilter — can assume a context exists.
 *
 * An inbound request id is trusted but bounded: a caller correlating its own traces is the
 * point, a caller injecting 8KB into every log line is not.
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { runWithRequestContext, type RequestContext } from '../logging/request-context';

const MAX_ID_LENGTH = 128;
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

interface Req {
  method: string;
  originalUrl?: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface Res {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Req, res: Res, next: () => void): void {
    const requestId = sanitise(req.headers['x-request-id']) ?? `req_${randomUUID()}`;

    res.setHeader('X-Request-Id', requestId);

    const context: RequestContext = {
      requestId,
      // CorrelationIdMiddleware overwrites this if the caller sent one.
      correlationId: requestId,
      principal: null,
      merchantId: null,
      livemode: false,
      method: req.method,
      path: req.originalUrl ?? req.url,
      startedAtMs: Date.now(),
    };

    runWithRequestContext(context, next);
  }
}

export function sanitise(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const trimmed = value.slice(0, MAX_ID_LENGTH);
  return SAFE_ID.test(trimmed) ? trimmed : null;
}
