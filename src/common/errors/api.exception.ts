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

  readonly code: ErrorCode = 'conflict';
}
