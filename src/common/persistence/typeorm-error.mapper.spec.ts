import { ConflictException } from 'src/common/errors/api.exception';
import {
  SQLSTATE,
  isLockNotAvailable,
  isSerializationFailure,
  isUniqueViolation,
  mapTypeOrmError,
} from 'src/common/persistence/typeorm-error.mapper';

/**
 * Driver errors → this repo's exception hierarchy.
 *
 * The constraint-name overload is what makes `DuplicateDisputeException` and
 * `IdempotencyKeyReuseException` reachable at all: both are a 23505, and the only thing
 * that distinguishes them is which unique index fired.
 */
describe('typeorm-error.mapper', () => {
  function driverError(code: string, constraint?: string): Error {
    return Object.assign(new Error(`driver said ${code}`), { code, constraint });
  }

  describe('SQLSTATE', () => {
    it('names the codes the repo actually branches on', () => {
      expect(SQLSTATE.UNIQUE_VIOLATION).toBe('23505');
      expect(SQLSTATE.SERIALIZATION_FAILURE).toBe('40001');
      expect(SQLSTATE.DEADLOCK_DETECTED).toBe('40P01');
    });
  });

  describe('isUniqueViolation', () => {
    it('can be narrowed to one constraint', () => {
      const err = driverError('23505', 'uq_dispute_charge_open');

      expect(isUniqueViolation(err, 'uq_dispute_charge_open')).toBe(true);
      expect(isUniqueViolation(err, 'uq_charge_processor_reference')).toBe(false);
    });

    it('recognises a deadlock as retryable too', () => {
      expect(isSerializationFailure(driverError('40P01'))).toBe(true);
    });

    it('does not treat a unique violation as retryable', () => {
      // Retrying a 23505 just produces another 23505 and hides a real business conflict.
      expect(isSerializationFailure(driverError('23505'))).toBe(false);
    });
  });

  describe('isLockNotAvailable', () => {
    it('recognises 55P03', () => {
      expect(isLockNotAvailable(driverError('55P03'))).toBe(true);
    });

    it('returns a serialization failure unchanged, so TransactionManager can retry it', () => {
      const err = driverError('40001');

      expect(mapTypeOrmError(err)).toBe(err);
    });

  });
});
