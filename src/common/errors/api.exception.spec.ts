import { PayzenoError } from '@payzeno/contracts/errors';

import {
  ApiException,
  ConflictException,
  InvalidRequestException,
  ValidationException,
  isApiException,
} from 'src/common/errors/api.exception';
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
  DisputeNotFoundException,
  MerchantNotFoundException,
  PaymentIntentNotFoundException,
  ResourceNotFoundException,
} from 'src/common/errors/not-found.exceptions';
import {
  ChargeNotCapturableException,
  InvalidMerchantTransitionException,
  InvalidStateTransitionException,
} from 'src/common/errors/state.exceptions';
import {
  LedgerRejectedException,
  LedgerUnavailableException,
  LegacyBillingUnavailableException,
  ProcessorUnavailableException,
  UpstreamException,
} from 'src/common/errors/upstream.exceptions';

import { TEST_CHARGE_ID, TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * Every `ApiException` subclass maps to its documented status (tests.md §3.2, against
 * api-surface.md §1.4).
 *
 * The table is written out by hand rather than derived from the classes, on purpose: a
 * status is a public contract with every merchant SDK, and a test that reads the status
 * off the class it is testing asserts nothing.
 */

const cases: Array<{ name: string; error: ApiException; status: number; code: string }> = [
  { name: 'ValidationException', error: new ValidationException('bad', []), status: 422, code: 'validation_failed' },
  { name: 'InvalidRequestException', error: new InvalidRequestException('bad'), status: 400, code: 'invalid_request' },
  { name: 'ConflictException', error: new ConflictException('nope'), status: 409, code: 'conflict' },
  { name: 'AuthenticationRequiredException', error: new AuthenticationRequiredException(), status: 401, code: 'authentication_required' },
  { name: 'InvalidApiKeyException', error: new InvalidApiKeyException(), status: 401, code: 'invalid_api_key' },
  { name: 'PermissionDeniedException', error: new PermissionDeniedException(), status: 403, code: 'permission_denied' },
  { name: 'ResourceNotFoundException', error: new ResourceNotFoundException('charge', TEST_CHARGE_ID), status: 404, code: 'not_found' },
  { name: 'MerchantNotFoundException', error: new MerchantNotFoundException(TEST_MERCHANT_ID), status: 404, code: 'not_found' },
  { name: 'PaymentIntentNotFoundException', error: new PaymentIntentNotFoundException(), status: 404, code: 'not_found' },
  { name: 'ChargeNotFoundException', error: new ChargeNotFoundException(TEST_CHARGE_ID), status: 404, code: 'not_found' },
  { name: 'DisputeNotFoundException', error: new DisputeNotFoundException(), status: 404, code: 'not_found' },
  { name: 'IdempotencyKeyReuseException', error: new IdempotencyKeyReuseException('k1'), status: 409, code: 'idempotency_key_reuse' },
  { name: 'IdempotencyInProgressException', error: new IdempotencyInProgressException('k1', 12), status: 409, code: 'idempotency_in_progress' },
  { name: 'InvalidStateTransitionException', error: new InvalidStateTransitionException('charge', 'settled', 'capture'), status: 409, code: 'invalid_state' },
  { name: 'InvalidMerchantTransitionException', error: new InvalidMerchantTransitionException('closed', 'approve'), status: 409, code: 'invalid_state' },
  { name: 'ChargeNotCapturableException', error: new ChargeNotCapturableException(TEST_CHARGE_ID, 'expired'), status: 409, code: 'invalid_state' },
  { name: 'RefundAmountExceededException', error: new RefundAmountExceededException(TEST_CHARGE_ID, 4_500, 9_000), status: 422, code: 'refund_amount_exceeded' },
  { name: 'RefundWindowClosedException', error: new RefundWindowClosedException(TEST_CHARGE_ID, 180), status: 422, code: 'refund_window_closed' },
  { name: 'DuplicateDisputeException', error: new DuplicateDisputeException(TEST_CHARGE_ID), status: 409, code: 'duplicate_dispute' },
  { name: 'DisputeWindowClosedException', error: new DisputeWindowClosedException('dp_1', null), status: 422, code: 'dispute_window_closed' },
  { name: 'MerchantRestrictedException', error: new MerchantRestrictedException(TEST_MERCHANT_ID, 'restricted'), status: 403, code: 'merchant_restricted' },
  { name: 'RateLimitedException', error: new RateLimitedException(60, 300), status: 429, code: 'rate_limited' },
  { name: 'CardDeclinedException', error: new CardDeclinedException('declined', 'do_not_honor'), status: 402, code: 'card_declined' },
  { name: 'InsufficientFundsException', error: new InsufficientFundsException(), status: 402, code: 'insufficient_funds' },
  { name: 'ExpiredCardException', error: new ExpiredCardException(), status: 402, code: 'expired_card' },
  { name: 'ProcessorUnavailableException', error: new ProcessorUnavailableException('worldflow'), status: 502, code: 'processor_unavailable' },
  { name: 'LedgerUnavailableException', error: new LedgerUnavailableException('getBalance'), status: 502, code: 'internal_error' },
  { name: 'LegacyBillingUnavailableException', error: new LegacyBillingUnavailableException('listInvoices'), status: 502, code: 'legacy_upstream_unavailable' },
];

describe('ApiException hierarchy', () => {
  describe.each(cases)('$name', ({ error, status, code }) => {
    it('carries the documented status', () => {
      expect(error.status).toBe(status);
    });

    it('carries the documented error code', () => {
      expect(error.code).toBe(code);
    });

    it('extends ApiException, and therefore PayzenoError', () => {
      expect(error).toBeInstanceOf(ApiException);
      expect(error).toBeInstanceOf(PayzenoError);
      expect(error).toBeInstanceOf(Error);
    });

    it('is recognised by isApiException', () => {
      expect(isApiException(error)).toBe(true);
    });

    it('serialises to the ApiError envelope', () => {
      const body = error.withRequestId('req_test').toResponse();

      expect(body).toBeApiError(code);
      expect(body.error.request_id).toBe('req_test');
      expect(body.error.message.length).toBeGreaterThan(0);
    });

    it('has a non-empty message', () => {
      expect(error.message.trim().length).toBeGreaterThan(0);
    });
  });

  it('covers every class in interfaces.md §2.4', () => {
    expect(cases).toHaveLength(28);
  });

  describe('subclass relationships', () => {
    it('the four not-found subclasses share the not_found code', () => {
      for (const err of [
        new MerchantNotFoundException(),
        new PaymentIntentNotFoundException(),
        new ChargeNotFoundException(),
        new DisputeNotFoundException(),
      ]) {
        expect(err).toBeInstanceOf(ResourceNotFoundException);
        expect(err.code).toBe('not_found');
      }
    });

    it('the two card subclasses extend CardDeclinedException', () => {
      expect(new InsufficientFundsException()).toBeInstanceOf(CardDeclinedException);
      expect(new ExpiredCardException()).toBeInstanceOf(CardDeclinedException);
    });

    it('the state subclasses extend InvalidStateTransitionException', () => {
      expect(new InvalidMerchantTransitionException('closed', 'approve')).toBeInstanceOf(
        InvalidStateTransitionException,
      );
      expect(new ChargeNotCapturableException(TEST_CHARGE_ID, 'expired')).toBeInstanceOf(
        InvalidStateTransitionException,
      );
    });

    it('the upstream subclasses extend UpstreamException', () => {
      for (const err of [
        new ProcessorUnavailableException('worldflow'),
        new LedgerUnavailableException('getBalance'),
        new LegacyBillingUnavailableException('listInvoices'),
        new LedgerRejectedException('settlement_locked', 409, 'locked'),
      ]) {
        expect(err).toBeInstanceOf(UpstreamException);
      }
    });
  });

  describe('LedgerRejectedException', () => {
    it('passes the ledger’s code and status through verbatim', () => {
      const err = new LedgerRejectedException('settlement_locked', 409, 'item already settled');

      expect(err.code).toBe('settlement_locked');
      expect(err.status).toBe(409);
    });

    it('does not collapse a 422 into a 502', () => {
      const err = new LedgerRejectedException('batch_not_reconcilable', 422, 'still open');

      expect(err.status).toBe(422);
    });

    it('carries the ledger’s details into the response envelope', () => {
      const err = new LedgerRejectedException('duplicate_settlement', 409, 'already posted', {
        existing_transaction_id: 'ltx_000777',
      });

      expect(err.withRequestId('req_1').toResponse().error.details).toMatchObject({
        existing_transaction_id: 'ltx_000777',
      });
    });
  });

  describe('details', () => {
    it('CardDeclinedException carries the decline code', () => {
      const err = new CardDeclinedException('declined', 'lost_card');

      expect(err.withRequestId('req_1').toResponse().error.details).toMatchObject({
        decline_code: 'lost_card',
      });
    });

    it('IdempotencyInProgressException carries retry_after', () => {
      const body = new IdempotencyInProgressException('k1', 12).withRequestId('req_1').toResponse();

      expect(body.error.retry_after).toBe(12);
    });

    it('RateLimitedException carries retry_after', () => {
      const body = new RateLimitedException(60, 300).withRequestId('req_1').toResponse();

      expect(body.error.retry_after).toBeGreaterThan(0);
    });

    it('ValidationException carries field_errors', () => {
      const body = new ValidationException('invalid', [
        { path: 'amount_minor', code: 'invalid_amount', message: 'must be an integer' },
      ])
        .withRequestId('req_1')
        .toResponse();

      expect(body.error.field_errors).toHaveLength(1);
      expect(body.error.field_errors?.[0].path).toBe('amount_minor');
    });
  });

  describe('withRequestId', () => {
    it('returns the same instance so a throw site can chain', () => {
      const err = new ConflictException('nope');

      expect(err.withRequestId('req_1')).toBe(err);
      expect(err.getRequestId()).toBe('req_1');
    });

    it('reports null before a request id is attached', () => {
      expect(new ConflictException('nope').getRequestId()).toBeNull();
    });
  });

  it('isApiException rejects a plain Error', () => {
    expect(isApiException(new Error('boom'))).toBe(false);
    expect(isApiException(null)).toBe(false);
    expect(isApiException('nope')).toBe(false);
  });
});
