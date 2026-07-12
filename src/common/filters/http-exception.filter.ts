/**
 * HttpExceptionFilter — the ONLY place anything becomes an HTTP response.
 *
 * One branch per row of api-surface.md §1.4, and a default that maps anything unrecognised to
 * `500 internal_error`. A raw `throw new HttpException` anywhere else in the repo is a review
 * rejection; `.eslintrc.cjs` bans the import outside this file, with an override here so the
 * filter can still catch Nest's own 404 for an unmatched route.
 *
 * Two behaviours worth knowing before you change anything:
 *
 *   `LedgerRejectedException` passes the LEDGER'S status and code through verbatim. A
 *   `409 settlement_locked` must arrive at the console as a 409 — after PAY-2043 that is the
 *   normal outcome of racing a sweep, not an error, and the console shows "already settling"
 *   and refetches. Collapsing it to a 502 turns a no-op into a page.
 *
 *   5xx is the only band that logs at error level. 402, 409 and 422 are business outcomes and
 *   logging them as errors is what made the error budget meaningless in month 6.
 */
import {
  Catch,
  HttpException,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';

import { CurrencyMismatchError, NotFoundError, PayzenoError, ValidationError } from '@payzeno/contracts/errors';
import type { ApiError, ErrorCode } from '@payzeno/contracts';

import { ApiException, ValidationException } from '../errors/api.exception';
import { RateLimitedException } from '../errors/business.exceptions';
import { IdempotencyInProgressException } from '../errors/idempotency.exceptions';
import { LedgerRejectedException } from '../errors/upstream.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../logging/logger';
import { currentRequestId } from '../logging/request-context';

interface HttpResponse {
  status(code: number): HttpResponse;
  setHeader(name: string, value: string): void;
  json(body: unknown): void;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(@Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpResponse>();
    const requestId = currentRequestId();

    const { status, body } = this.translate(exception, requestId);

    this.applyHeaders(res, exception);
    this.log(status, body.error.code, exception);

    res.status(status).json(body);
  }

  /** The branch table. Order matters: the most specific class first. */
  private translate(exception: unknown, requestId: string): { status: number; body: ApiError } {
    // The passthrough. Must precede the ApiException branch or its status is lost.
    if (exception instanceof LedgerRejectedException) {
      return { status: exception.httpStatus, body: exception.toResponse(requestId) };
    }

    if (exception instanceof ValidationException) {
      return { status: 422, body: exception.toResponse(requestId) };
    }

    if (exception instanceof ApiException) {
      return { status: exception.httpStatus, body: exception.toResponse(requestId) };
    }

    // Contracts-level errors thrown by shared money/id helpers, which know nothing of Nest.
    if (exception instanceof PayzenoError) {
      return {
        status: this.statusForContractsError(exception),
        body: exception.toApiError(requestId),
      };
    }

    // Nest's own 404 for an unmatched route, and nothing else — everything we throw is an
    // ApiException by now.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: envelope(status === 404 ? 'not_found' : 'invalid_request', exception.message, requestId),
      };
    }

    return { status: 500, body: envelope('internal_error', 'An unexpected error occurred', requestId) };
  }

  private statusForContractsError(err: PayzenoError): number {
