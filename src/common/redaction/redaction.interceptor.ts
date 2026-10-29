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
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';

import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import {
  ACCEPTS_SECRET_FIELDS_KEY,
  RETURNS_SECRET_FIELDS_KEY,
  type ExemptableSecretField,
} from '../decorators/secret-fields.decorator';
import { FLAG_NAMES } from '../flags/flag-names';

import { NO_EXEMPTIONS } from './redaction.denylist';
import { scrubDeep } from './scrub';

interface RequestLike {
  body?: unknown;
  method: string;
  originalUrl?: string;
}

@Injectable()
export class RedactionInterceptor implements NestInterceptor {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // `redact_pan_in_logs` is on and non-removable — the flag exists so the runbook can
    // point at something, not so anybody can turn it off. FLAG_NAMES documents that.
    if (!this.config.flags.redactPanInLogs) {
      return next.handle();
    }

    if (context.getType() === 'http') {
      const req = context.switchToHttp().getRequest<RequestLike>();
      if (req.body && typeof req.body === 'object') {
        req.body = this.scrub(req.body, this.exemptions(context, ACCEPTS_SECRET_FIELDS_KEY));
      }
    }

    const returned = this.exemptions(context, RETURNS_SECRET_FIELDS_KEY);
    return next.handle().pipe(map((body) => this.scrub(body, returned)));
  }

  /**
   * Field denylist first (cheap, exact), then the Luhn scan over remaining strings. `exempt`
   * spares a route's own credentials from the first pass only — never from the PAN scan.
   */
  scrub(value: unknown, exempt: ReadonlySet<string> = NO_EXEMPTIONS): unknown {
    return scrubDeep(value, exempt);
  }

  /** The handler's and the controller's `@AcceptsSecretFields` / `@ReturnsSecretFields`, merged. */
  private exemptions(context: ExecutionContext, key: string): ReadonlySet<string> {
    const fields = this.reflector.getAllAndMerge<ExemptableSecretField[]>(key, [
      context.getHandler(),
      context.getClass(),
    ]);
    return fields.length === 0 ? NO_EXEMPTIONS : new Set(fields);
  }
}

/** Named so the runbook and the ADR can refer to the flag by the same symbol the code uses. */
export const REDACTION_FLAG = FLAG_NAMES.REDACT_PAN_IN_LOGS;
