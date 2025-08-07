import { HttpException, NotFoundException as NestNotFound, type ArgumentsHost } from '@nestjs/common';

import {
  CurrencyMismatchError,
  NotFoundError,
  ValidationError,
} from '@payzeno/contracts/errors';

import { ValidationException } from 'src/common/errors/api.exception';
import {
  AuthenticationRequiredException,
  InvalidApiKeyException,
  PermissionDeniedException,
} from 'src/common/errors/auth.exceptions';
import {
  DisputeWindowClosedException,
  DuplicateDisputeException,
  MerchantRestrictedException,
  RateLimitedException,
  RefundAmountExceededException,
  RefundWindowClosedException,
} from 'src/common/errors/business.exceptions';
import {
  CardDeclinedException,
  ExpiredCardException,
  InsufficientFundsException,
} from 'src/common/errors/card.exceptions';
import {
  IdempotencyInProgressException,
  IdempotencyKeyReuseException,
} from 'src/common/errors/idempotency.exceptions';
import {
  ChargeNotFoundException,
  MerchantNotFoundException,
  PaymentIntentNotFoundException,
} from 'src/common/errors/not-found.exceptions';
import {
  ChargeNotCapturableException,
  InvalidStateTransitionException,
} from 'src/common/errors/state.exceptions';
import {
  LedgerRejectedException,
  LedgerUnavailableException,
  LegacyBillingUnavailableException,
  ProcessorUnavailableException,
} from 'src/common/errors/upstream.exceptions';
import { HttpExceptionFilter } from 'src/common/filters/http-exception.filter';
import { NoopLogger } from 'src/common/logging/logger';

import { makeResponse, type ResponseDouble } from 'test/support/guard-context';

/**
 * The ONLY place anything in this repo becomes an HTTP response. One case per
 * api-surface.md §1.4 row, plus the two behaviours the header comment on the filter calls
 * out by name:
 *
 *   `LedgerRejectedException` passes the ledger's status AND code through verbatim. After
 *   PAY-2043 a `409 settlement_locked` is the normal outcome of racing the sweep, and the
 *   console shows "already settling" and refetches. Collapsing it to 502 turns a no-op into
 *   a page.
 *
 *   Only 5xx logs at error level. 402, 409 and 422 are business outcomes, and logging them
 *   as errors is what made the error budget meaningless in month 6.
 */
describe('HttpExceptionFilter', () => {
  let logger: NoopLogger;
  let filter: HttpExceptionFilter;
  let response: ResponseDouble;

  function host(): ArgumentsHost {
    return {
      switchToHttp: () => ({ getResponse: <T>() => response as unknown as T }),
    } as unknown as ArgumentsHost;
  }

  function caught(exception: unknown): { status: number; body: { error: Record<string, unknown> } } {
    filter.catch(exception, host());
    return {
      status: response.statusCode as number,
      body: response.body as { error: Record<string, unknown> },
    };
  }

  beforeEach(() => {
    logger = new NoopLogger();
    jest.spyOn(logger, 'error');
    jest.spyOn(logger, 'warn');
    jest.spyOn(logger, 'debug');
    filter = new HttpExceptionFilter(logger);
    response = makeResponse();
  });

  describe.each<[string, () => unknown, number, string]>([
    ['ValidationException', () => new ValidationException('bad body', []), 422, 'validation_failed'],
    [
      'AuthenticationRequiredException',
      () => new AuthenticationRequiredException(),
      401,
      'authentication_required',
    ],
    ['InvalidApiKeyException', () => new InvalidApiKeyException(), 401, 'invalid_api_key'],
    ['PermissionDeniedException', () => new PermissionDeniedException(), 403, 'permission_denied'],
    ['MerchantNotFoundException', () => new MerchantNotFoundException('mch_1'), 404, 'not_found'],
    [
      'PaymentIntentNotFoundException',
      () => new PaymentIntentNotFoundException('pi_1'),
      404,
      'not_found',
    ],
    ['ChargeNotFoundException', () => new ChargeNotFoundException('ch_1'), 404, 'not_found'],
    [
      'IdempotencyKeyReuseException',
      () => new IdempotencyKeyReuseException('idem-1'),
      409,
      'idempotency_key_reuse',
    ],
    [
      'IdempotencyInProgressException',
      () => new IdempotencyInProgressException('idem-1', 2),
      409,
      'idempotency_in_progress',
    ],
    [
      'InvalidStateTransitionException',
      () => new InvalidStateTransitionException('charge', 'settled', 'capture'),
      409,
      'invalid_state',
    ],
    [
      'ChargeNotCapturableException',
      () => new ChargeNotCapturableException('settled', 'capture'),
      409,
      'invalid_state',
    ],
    ['DuplicateDisputeException', () => new DuplicateDisputeException('ch_1'), 409, 'duplicate_dispute'],
    [
      'RefundAmountExceededException',
      () => new RefundAmountExceededException('ch_1', 5_000, 1_000, 'GBP'),
      422,
      'refund_amount_exceeded',
    ],
    [
      'RefundWindowClosedException',
      () => new RefundWindowClosedException('ch_1', 120),
      422,
      'refund_window_closed',
    ],
    [
      'DisputeWindowClosedException',
      () => new DisputeWindowClosedException('dp_1', '2026-03-01T00:00:00.000Z'),
      422,
      'dispute_window_closed',
    ],
    [
      'MerchantRestrictedException',
      () => new MerchantRestrictedException('mch_1', 'suspended', 'POST'),
      403,
      'merchant_restricted',
    ],
    ['RateLimitedException', () => new RateLimitedException(30, 300), 429, 'rate_limited'],
    ['CardDeclinedException', () => new CardDeclinedException('do_not_honor'), 402, 'card_declined'],
    ['InsufficientFundsException', () => new InsufficientFundsException(), 402, 'insufficient_funds'],
    ['ExpiredCardException', () => new ExpiredCardException(), 402, 'expired_card'],
    [
      'ProcessorUnavailableException',
      () => new ProcessorUnavailableException('worldflow', 'ECONNRESET'),
      502,
      'processor_unavailable',
    ],
    [
      'LedgerUnavailableException',
      () => new LedgerUnavailableException('postTransaction', 'read timeout'),
      502,
      'internal_error',
    ],
    [
      'LegacyBillingUnavailableException',
      () => new LegacyBillingUnavailableException('listInvoices', true),
      502,
      'legacy_upstream_unavailable',
    ],
  ])('%s', (_name, build, status, code) => {
    it(`becomes ${status} ${code}`, () => {
      const { status: got, body } = caught(build());

      expect(got).toBe(status);
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe('string');
      expect(body.error.request_id).toBeDefined();
    });
  });

  describe('LedgerRejectedException passthrough', () => {
    it('keeps a 409 settlement_locked as a 409, not a 502', () => {
      const { status, body } = caught(
        new LedgerRejectedException('settlement_locked', 409, 'batch is reconciling', {
          batch_id: 'sb_1',
        }),
      );

      expect(status).toBe(409);
      expect(body.error.code).toBe('settlement_locked');
      expect(body.error.details).toMatchObject({ batch_id: 'sb_1' });
    });

    it('keeps a 422 ledger_imbalance as a 422', () => {
      const { status, body } = caught(
        new LedgerRejectedException('ledger_imbalance', 422, 'debits != credits'),
      );

      expect(status).toBe(422);
      expect(body.error.code).toBe('ledger_imbalance');
    });

    it('precedes the generic ApiException branch, or the status would be lost', () => {
      // 402 is not any of the upstream defaults; if the generic branch won it would be 502.
      const { status } = caught(new LedgerRejectedException('card_declined', 402, 'declined'));

      expect(status).toBe(402);
    });
  });

  describe('field_errors', () => {
    it('are carried on a validation failure', () => {
      const { body } = caught(
        new ValidationException('bad body', [
          { path: 'amount_minor', code: 'too_small', message: 'must be at least 50' },
        ]),
      );

      expect(body.error.field_errors).toEqual([
        { path: 'amount_minor', code: 'too_small', message: 'must be at least 50' },
      ]);
    });
  });

  describe('Retry-After', () => {
    it('is set on 429', () => {
      caught(new RateLimitedException(37, 300));

      expect(response.headers['Retry-After']).toBe('37');
    });

    it('is set on 409 idempotency_in_progress', () => {
      caught(new IdempotencyInProgressException('idem-1', 4));

      expect(response.headers['Retry-After']).toBe('4');
    });

    it('is not set on anything else', () => {
      caught(new ChargeNotFoundException('ch_1'));

      expect(response.headers['Retry-After']).toBeUndefined();
    });
  });

  describe('contracts-level errors thrown by shared helpers', () => {
    it('maps ValidationError to 422', () => {
      expect(caught(new ValidationError('amount_minor must be an integer')).status).toBe(422);
    });

    it('maps NotFoundError to 404', () => {
      expect(caught(new NotFoundError('No such charge: ch_1', { charge_id: 'ch_1' })).status).toBe(
        404,
      );
    });

    it('maps CurrencyMismatchError to 400 — it is a caller error, not a missing resource', () => {
      // Payzeno is multi-currency and never cross-currency; there is no FX to fall back on.
      const { status, body } = caught(new CurrencyMismatchError('cannot add GBP to USD'));

      expect(status).toBe(400);
      expect(body.error.code).toBe('currency_mismatch');
    });
  });

  describe('Nest’s own exceptions', () => {
    it('maps an unmatched route to 404 not_found', () => {
      const { status, body } = caught(new NestNotFound('Cannot GET /v1/nope'));

      expect(status).toBe(404);
      expect(body.error.code).toBe('not_found');
    });

    it('maps any other HttpException to invalid_request at its own status', () => {
      const { status, body } = caught(new HttpException('payload too large', 413));

      expect(status).toBe(413);
      expect(body.error.code).toBe('invalid_request');
    });
  });

  describe('the default branch', () => {
    it('turns an unrecognised throw into 500 internal_error', () => {
      const { status, body } = caught(new TypeError('cannot read properties of undefined'));

      expect(status).toBe(500);
      expect(body.error.code).toBe('internal_error');
    });

    it('does not leak the original message', () => {
      const { body } = caught(new Error('connection string postgres://user:hunter2@db/payzeno'));

      expect(String(body.error.message)).not.toContain('hunter2');
    });

    it('handles a non-Error throw without exploding', () => {
      expect(caught('a bare string').status).toBe(500);
      expect(caught(undefined).status).toBe(500);
    });
  });

  describe('log levels', () => {
    it('logs 5xx at error', () => {
      caught(new LedgerUnavailableException('postTransaction'));

      expect(logger.error).toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it('logs 429 at warn', () => {
      caught(new RateLimitedException(10, 300));

      expect(logger.warn).toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });

    it.each([
      ['402', () => new CardDeclinedException('do_not_honor')],
      ['409', () => new DuplicateDisputeException('ch_1')],
      ['422', () => new RefundWindowClosedException('ch_1', 120)],
    ])('logs %s at debug — a business outcome is not a fault', (_label, build) => {
      caught(build());

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalled();
    });
  });
});
