/**
 * Third link. One structured line per request, on the way out.
 *
 * Deliberately logs nothing on the way in: an access log that emits a line at request start
 * doubles the volume and tells you nothing you cannot infer from the completion line. The
 * exception is a slow request, which gets a warn — apager's threshold, and the number the
 * latency alarm in payzeno-infrastructure is set against.
 *
 * Bodies never appear here. RedactionInterceptor runs after this middleware, so anything this
 * file logged from `req.body` would be pre-redaction.
 */
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../logging/logger';
import { getRequestContext } from '../logging/request-context';

const SLOW_REQUEST_MS = 1_000;

interface Req {
  method: string;
  originalUrl?: string;
  url: string;
  ip?: string;
}

interface Res {
  statusCode: number;
  on(event: 'finish', listener: () => void): void;
}

@Injectable()
export class StructuredLoggerMiddleware implements NestMiddleware {
  constructor(@Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger) {}

  use(req: Req, res: Res, next: () => void): void {
    const startedAt = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      const context = getRequestContext();

      const line = {
        method: req.method,
        path: req.originalUrl ?? req.url,
        status: res.statusCode,
        duration_ms: durationMs,
        merchant_id: context?.merchantId ?? null,
        principal_kind: context?.principal?.kind ?? 'anonymous',
        livemode: context?.livemode ?? false,
      };

      if (res.statusCode >= 500) {
        this.logger.error('request failed', undefined, line);
      } else if (durationMs >= SLOW_REQUEST_MS) {
        this.logger.warn('slow request', line);
      } else {
        this.logger.info('request', line);
      }
    });

    next();
  }
}
