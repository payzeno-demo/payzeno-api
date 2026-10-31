/**
 * The default IdempotencyStore. Same database as the business write, so a completed record
 * and the row it describes cannot disagree.
 *
 * `begin` is one statement. INSERT … ON CONFLICT DO UPDATE with a WHERE on the conflict
 * target reclaims an expired lease and does nothing otherwise, and the RETURNING tells us
 * which happened. Two statements here is the PAY-1602 race: two requests both read "no row",
 * both insert, one gets a 23505 that nothing catches.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { CLOCK, type Clock } from '../time/clock';

import type { IdempotencyStore } from './idempotency.store';
import type { IdempotencyBeginResult } from './idempotency.types';

interface BeginRow {
  claimed: boolean;
  state: string;
  fingerprint: string;
  response_status: number | null;
  response_body: unknown;
  lease_expires_at: Date;
}

@Injectable()
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    // Not a provider — the idempotency harness passes it explicitly. `@Optional()` makes Nest hand
    // over undefined, so the default applies, instead of hunting for a `Boolean` token.
    @Optional() private readonly livemode: boolean = true,
  ) {}

  async begin(merchantId: string, key: string, fingerprint: string): Promise<IdempotencyBeginResult> {
    const now = this.clock.now();
    const lease = this.clock.plusSeconds(this.config.idempotency.leaseSeconds);
    const expires = this.clock.plusSeconds(this.config.idempotency.ttlHours * 3600);

    const [row] = (await this.dataSource.query(
      `
      INSERT INTO idempotency_record
        (merchant_id, livemode, key, fingerprint, state, lease_expires_at, created_at, expires_at)
      VALUES ($1, $2, $3, $4, 'in_progress', $5, $6, $7)
      ON CONFLICT (merchant_id, livemode, key) DO UPDATE
        SET state = 'in_progress',
            fingerprint = EXCLUDED.fingerprint,
            lease_expires_at = EXCLUDED.lease_expires_at,
            response_status = NULL,
            response_body = NULL
        WHERE idempotency_record.state = 'in_progress'
          AND idempotency_record.lease_expires_at < $6
          AND idempotency_record.fingerprint = EXCLUDED.fingerprint
      RETURNING true AS claimed, state, fingerprint, response_status, response_body, lease_expires_at
      `,
      [merchantId, this.livemode, key, fingerprint, lease, now, expires],
    )) as BeginRow[];

    if (row?.claimed) return { outcome: 'proceed' };

    // No row returned: the conflict existed and the reclaim predicate did not hold. Read it.
    const [existing] = (await this.dataSource.query(
      `SELECT state, fingerprint, response_status, response_body, lease_expires_at
         FROM idempotency_record
        WHERE merchant_id = $1 AND livemode = $2 AND key = $3`,
      [merchantId, this.livemode, key],
    )) as BeginRow[];

    if (!existing) {
      // Retention deleted it between the two statements. Rare, and retrying is correct.
      return this.begin(merchantId, key, fingerprint);
    }

    if (existing.fingerprint !== fingerprint) return { outcome: 'fingerprint_mismatch' };

    if (existing.state === 'completed' && existing.response_status !== null) {
      return { outcome: 'replay', status: existing.response_status, body: existing.response_body };
    }

    if (existing.state === 'failed') {
      // A failed attempt is retryable with the same key: a 500 is not a business outcome.
      await this.reopen(merchantId, key, fingerprint);
      return { outcome: 'proceed' };
    }

    return { outcome: 'in_progress', retryAfterSec: this.retryAfterFor(existing.lease_expires_at) };
  }

  async complete(merchantId: string, key: string, status: number, body: unknown): Promise<void> {
    await this.dataSource.query(
      `UPDATE idempotency_record
          SET state = 'completed', response_status = $4, response_body = $5
        WHERE merchant_id = $1 AND livemode = $2 AND key = $3`,
      [merchantId, this.livemode, key, status, body === undefined ? null : JSON.stringify(body)],
    );
  }

  async fail(merchantId: string, key: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE idempotency_record
          SET state = 'failed', lease_expires_at = $4
        WHERE merchant_id = $1 AND livemode = $2 AND key = $3`,
      [merchantId, this.livemode, key, this.clock.now()],
    );
  }

  private async reopen(merchantId: string, key: string, fingerprint: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE idempotency_record
          SET state = 'in_progress', fingerprint = $4, lease_expires_at = $5,
              response_status = NULL, response_body = NULL
        WHERE merchant_id = $1 AND livemode = $2 AND key = $3`,
      [merchantId, this.livemode, key, fingerprint, this.clock.plusSeconds(this.config.idempotency.leaseSeconds)],
    );
  }

  /**
   * Time until the holder's lease lapses, floored at 1s. RedisIdempotencyStore derives this
   * from the remaining PTTL instead and rounds differently — the two are not identical and
   * `idempotency.store.contract.spec.ts` asserts each separately rather than pretending.
   */
  private retryAfterFor(leaseExpiresAt: Date): number {
    const remainingMs = leaseExpiresAt.getTime() - this.clock.nowMs();
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }
}
