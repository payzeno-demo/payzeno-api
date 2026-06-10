/**
 * The root of payzeno-api's exception tree.
 *
 * `ApiException extends PayzenoError` (from @payzeno/contracts) on purpose: payzeno-console's
 * client parses the same `ApiError` envelope, and payzeno-ledger's `problem_handler` produces
 * it too. One shape, three runtimes. See docs/adr/0001-nestjs-module-boundaries.md §4.
 *
 * Nothing outside src/common/filters/http-exception.filter.ts turns one of these into an HTTP
 * response, and nothing anywhere throws a raw Nest `HttpException`. Both rules are enforced by
 * .eslintrc.cjs, not by convention.
 */
import { PayzenoError } from '@payzeno/contracts/errors';
import type { ApiError, ErrorCode, FieldError } from '@payzeno/contracts';

export abstract class ApiException extends PayzenoError {
  /** Stamped by HttpExceptionFilter from the request-scoped id; null until then. */
  private requestId: string | null = null;

  withRequestId(requestId: string): this {
    this.requestId = requestId;
    return this;
  }

  getRequestId(): string | null {
    return this.requestId;
  }

  /**
   * The wire body. Note `details` is narrowed to scalars — a nested object here is how
   * cardholder data escaped into an error response the first time (arc PCI, PAY-1740).
   */
  readonly httpStatus = 422;

  constructor(
    message: string,
    readonly fieldErrors: FieldError[] = [],
    details?: Record<string, unknown>,
  ) {
    super(message, details);
  }

  override toResponse(requestId?: string): ApiError {
    const body = super.toResponse(requestId);
    if (this.fieldErrors.length > 0) {
      body.error.field_errors = this.fieldErrors;
    }
    return body;
  }
}

/** 400. The catch-all for a request that is malformed rather than semantically wrong. */
export class InvalidRequestException extends ApiException {
  readonly code: ErrorCode = 'invalid_request';
  readonly httpStatus = 400;
}

/** 409. Generic conflict for the cases with no better class — currently unique-index races. */
export class ConflictException extends ApiException {
  readonly code: ErrorCode = 'conflict';
  readonly httpStatus = 409;
}

export function isApiException(err: unknown): err is ApiException {
  return err instanceof ApiException;
}
