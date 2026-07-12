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

export const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  CHECK_VIOLATION: '23514',
  NOT_NULL_VIOLATION: '23502',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
} as const;

function asDriverError(err: unknown): DriverError | null {
  if (typeof err !== 'object' || err === null) return null;
  const candidate = err as DriverError;
  return typeof candidate.code === 'string' ? candidate : null;
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const driver = asDriverError(err);
  if (!driver || driver.code !== SQLSTATE.UNIQUE_VIOLATION) return false;
  return constraint ? driver.constraint === constraint : true;
}

export function isSerializationFailure(err: unknown): boolean {
  const driver = asDriverError(err);
  return (
    driver?.code === SQLSTATE.SERIALIZATION_FAILURE || driver?.code === SQLSTATE.DEADLOCK_DETECTED
  );
}

export function isLockNotAvailable(err: unknown): boolean {
  return asDriverError(err)?.code === SQLSTATE.LOCK_NOT_AVAILABLE;
}

/**
 * Translates a driver error, or returns it untouched when it is already an ApiException or
 * is not a driver error at all. Callers do `throw mapTypeOrmError(err)`.
 */
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

/** `Key (charge_id)=(ch_01H…) already exists.` — Postgres detail strings are stable enough. */
function extractChargeId(detail: string | undefined): string | null {
  return detail?.match(/\(charge_id\)=\(([^)]+)\)/)?.[1] ?? null;
}

function extractKey(detail: string | undefined): string | null {
  return detail?.match(/, ([^,)]+)\)$/)?.[1] ?? null;
}
