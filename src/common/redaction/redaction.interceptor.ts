/**
 * RedactionInterceptor — arc PCI, the fourth link in the middleware chain (api-surface §1.5).
 *
 * Applies BOTH passes of domain-model.md §11.2 to four surfaces:
 *   1. the request body, before ValidationPipe and before anything logs it
 *   2. the response body, on the way out
 *   3. the log context (via PinoPayzenoLogger, which calls the same denylist)
 *   4. `ValidationError.field_errors[].path` (via validation-exception.factory.ts)
 *
 * The interceptor mutates the request body in place because the audit interceptor, the
 * idempotency fingerprint and the access log all read `req.body` after us. Redacting a copy
 * leaves three readers looking at the original.
 */
import { Inject, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { FLAG_NAMES } from '../flags/flag-names';

import { maskPans } from './pan.matcher';
import { redactDeep } from './redaction.denylist';

interface RequestLike {
  body?: unknown;
  method: string;
  originalUrl?: string;
}

@Injectable()
export class RedactionInterceptor implements NestInterceptor {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // `redact_pan_in_logs` is on and non-removable — the flag exists so the runbook can
    // point at something, not so anybody can turn it off. FLAG_NAMES documents that.
    if (!this.config.flags.redactPanInLogs) {
      return next.handle();
    }

    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest<RequestLike>();
      if (req.body && typeof req.body === 'object') {
        req.body = this.scrub(req.body);
      }
    }

    return next.handle().pipe(map((body) => this.scrub(body)));
  }

  /** Field denylist first (cheap, exact), then the Luhn scan over remaining strings. */
  scrub(value: unknown): unknown {
    return this.maskStrings(redactDeep(value));
  }

  private maskStrings(value: unknown, depth = 0): unknown {
    if (depth > 12 || value === null || value === undefined) return value;

    if (typeof value === 'string') return maskPans(value);

    if (Array.isArray(value)) return value.map((item) => this.maskStrings(item, depth + 1));

    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = this.maskStrings(child, depth + 1);
      }
      return out;
    }

    return value;
  }
}

/** Named so the runbook and the ADR can refer to the flag by the same symbol the code uses. */
export const REDACTION_FLAG = FLAG_NAMES.REDACT_PAN_IN_LOGS;
