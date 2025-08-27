/**
 * The default IdempotencyStore. Same database as the business write, so a completed record
 * and the row it describes cannot disagree.
 *
 * `begin` is one statement. INSERT … ON CONFLICT DO UPDATE with a WHERE on the conflict
 * target reclaims an expired lease and does nothing otherwise, and the RETURNING tells us
 * which happened. Two statements here is the PAY-1602 race: two requests both read "no row",
 * both insert, one gets a 23505 that nothing catches.
 */
import { Inject, Injectable } from '@nestjs/common';
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
    const lease = this.clock.plusSeconds(this.config.idempotency.leaseSeconds);
  }
}
