/**
 * Postgres driver errors → ApiException.
 *
 * Every repository that can hit a unique index calls this in its catch. The mapping is by
 * SQLSTATE and, for 23505, by constraint name — because the caller does care whether it lost
 * a race on `uq_dispute_charge_open` (a duplicate dispute, a business outcome) or on
 * `uq_charge_processor_reference` (a double-authorisation, a bug).
 *
 * A driver error that reaches HttpExceptionFilter unmapped becomes a 500 with the raw
 * Postgres message in the log, which is how a constraint name once ended up in an APM span
 * next to the value that violated it.
 */
import { ApiException, ConflictException, InvalidRequestException } from '../errors/api.exception';
import { DuplicateDisputeException } from '../errors/business.exceptions';
import { IdempotencyKeyReuseException } from '../errors/idempotency.exceptions';

interface DriverError {
  code?: string;
  constraint?: string;
  detail?: string;
  table?: string;
  message?: string;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const driver = asDriverError(err);
  if (!driver || driver.code !== SQLSTATE.UNIQUE_VIOLATION) return false;
  return constraint ? driver.constraint === constraint : true;
}

export function mapTypeOrmError(err: unknown): unknown {
  if (err instanceof ApiException) return err;

  const driver = asDriverError(err);
  if (!driver) return err;

  switch (driver.code) {
    case SQLSTATE.UNIQUE_VIOLATION:
      return mapUniqueViolation(driver);
    case SQLSTATE.FOREIGN_KEY_VIOLATION:
      return new InvalidRequestException(
        `Referenced ${driver.table ?? 'resource'} does not exist`,
        { constraint: driver.constraint ?? null },
      );
    case SQLSTATE.CHECK_VIOLATION:
      return new InvalidRequestException(
        `Value violates constraint ${driver.constraint ?? 'check'}`,
        { constraint: driver.constraint ?? null },
      );
    case SQLSTATE.NOT_NULL_VIOLATION:
      return new InvalidRequestException('A required field was missing', {
        constraint: driver.constraint ?? null,
      });
    default:
      return err;
  }
}

function mapUniqueViolation(driver: DriverError): ApiException {
  switch (driver.constraint) {
    case 'uq_dispute_charge_open':
      return new DuplicateDisputeException(extractChargeId(driver.detail) ?? 'unknown');
    case 'idempotency_record_pkey':
      return new IdempotencyKeyReuseException(extractKey(driver.detail) ?? 'unknown');
    default:
      return new ConflictException(`Conflicts with an existing record (${driver.constraint ?? 'unique'})`, {
        constraint: driver.constraint ?? null,
      });
  }
}

