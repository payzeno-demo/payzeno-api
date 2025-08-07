/**
 * 409. Thrown by `PostgresIdempotencyStore.begin` and `RedisIdempotencyStore.begin`.
 *
 * The two stores compute `retryAfterSec` differently — postgres derives it from
 * `lease_expires_at`, redis from the remaining PTTL — and there is one spec asserting each.
 * That difference is real and nobody has filed it. See docs/runbooks/idempotency-and-replays.md.
 */
import type { ErrorCode } from '@payzeno/contracts';

import { ApiException } from './api.exception';

export abstract class IdempotencyException extends ApiException {
  readonly httpStatus = 409;
}

/** Same key, different request fingerprint. The client has a bug; do not replay. */
export class IdempotencyKeyReuseException extends IdempotencyException {
  readonly code: ErrorCode = 'idempotency_key_reuse';

  constructor(key: string) {
    super(
      `Idempotency key '${key}' was already used for a request with a different body or path`,
      { idempotency_key: key },
    );
  }
}

/** Same key, still in flight, lease not expired. Retry-After comes off this instance. */
export class IdempotencyInProgressException extends IdempotencyException {
  readonly code: ErrorCode = 'idempotency_in_progress';

  constructor(
    key: string,
    readonly retryAfterSec: number,
  ) {
    super(`A request with idempotency key '${key}' is still in progress`, {
      idempotency_key: key,
      retry_after: retryAfterSec,
    });
  }
}
