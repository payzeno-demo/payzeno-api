/**
 * IdempotencyInterceptor — the ninth link in the middleware chain, after the auth guards
 * (it needs `principal.merchant_id`) and before ValidationPipe.
 *
 * Runs only on handlers carrying `@Idempotent()`. Order of operations:
 *
 *   1. read + validate the Idempotency-Key header (≤ 255 chars)
 *   2. fingerprint method + path + canonical body
 *   3. store.begin → proceed | replay | in_progress | fingerprint_mismatch
 *   4. on success store.complete; on any thrown exception store.fail
 *
 * A replayed response carries `Idempotent-Replay: true` and the ORIGINAL status code. A
 * replay that returns 200 for a call that first returned 201 breaks every client that keys
 * off the status.
 */
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { catchError, of, tap, throwError, type Observable } from 'rxjs';

import type { AuthPrincipal } from '@payzeno/contracts';

import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { IDEMPOTENT_KEY, type IdempotentOptions } from '../decorators/idempotent.decorator';
import { InvalidRequestException } from '../errors/api.exception';
import {
  IdempotencyInProgressException,
  IdempotencyKeyReuseException,
} from '../errors/idempotency.exceptions';
import type { PayzenoLogger } from '../logging/logger';
import { PAYZENO_LOGGER } from '../logging/logger';

import type { IdempotencyStore } from './idempotency.store';
import {
  fingerprint,
  IDEMPOTENCY_HEADER,
  IDEMPOTENT_REPLAY_HEADER,
  isValidIdempotencyKey,
} from './idempotency.types';

interface HttpRequest {
  method: string;
  originalUrl?: string;
  url: string;
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  principal?: AuthPrincipal;
}

interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  status(code: number): HttpResponse;
}

export const POSTGRES_IDEMPOTENCY_STORE = Symbol('POSTGRES_IDEMPOTENCY_STORE');
export const REDIS_IDEMPOTENCY_STORE = Symbol('REDIS_IDEMPOTENCY_STORE');

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(REDIS_IDEMPOTENCY_STORE) private readonly redisStore: IdempotencyStore,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const merchantId = merchantIdOf(req.principal);

    // Internal and staff-without-merchant surfaces are not idempotency-scoped.
    if (!merchantId) return next.handle();

    const key = headerValue(req.headers[IDEMPOTENCY_HEADER]);
    if (!isValidIdempotencyKey(key)) {
      if (options.required === false) return next.handle();
      throw new InvalidRequestException(
        `${IDEMPOTENCY_HEADER} header is required and must be 1-255 characters`,
      );
    }

    const print = fingerprint(req.method, stripQuery(path), req.body);

  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function stripQuery(path: string): string {
  const index = path.indexOf('?');
  return index === -1 ? path : path.slice(0, index);
}
