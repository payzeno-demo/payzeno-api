/**
 * Second link. Reads `X-Correlation-Id` and seeds the context value every publisher stamps
 * onto `EventEnvelope.correlation_id`.
 *
 * This is the whole propagation mechanism for the field events.ts requires to be carried from
 * the originating HTTP request. Console → api → ledger → back onto the bus → into a webhook:
 * one id across five hops and three runtimes. Falls back to the request id, never to a fresh
 * value — two different ids for one request is worse than one id repeated.
 */
import { Injectable, type NestMiddleware } from '@nestjs/common';

import { getRequestContext } from '../logging/request-context';

import { sanitise } from './request-id.middleware';

interface Req {
  headers: Record<string, string | string[] | undefined>;
}

interface Res {
  setHeader(name: string, value: string): void;
}

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Req, res: Res, next: () => void): void {
    const context = getRequestContext();
    const inbound = sanitise(req.headers['x-correlation-id']);

    if (context) {
      context.correlationId = inbound ?? context.requestId;
      res.setHeader('X-Correlation-Id', context.correlationId);
    }

    next();
  }
}
