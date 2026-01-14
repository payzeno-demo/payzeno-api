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
