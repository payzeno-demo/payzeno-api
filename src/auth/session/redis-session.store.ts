/**
 * RedisSessionStore — the production SessionStore.
 *
 * Two keys per session:
 *
 *   sess:<sessionId>        the JSON record, TTL = SESSION_TTL
 *   sess:user:<userId>      a SET of that user's live session ids, TTL = SESSION_TTL
 *
 * The reverse index exists for one operation, and it is not a nice-to-have:
 * `destroyAllForUser` is what a password reset calls, and without it a reset leaves every
 * stolen session alive for its full TTL. `SCAN`ning for them instead would walk the whole
 * keyspace of a shared Redis on the one code path that must not be slow.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

import type { UserId } from '@payzeno/contracts';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { redisKey, REDIS_CLIENT } from '../../config/redis.config';

import { subjectOf, type SessionRecord, type SessionStore } from './session.store';

@Injectable()
export class RedisSessionStore implements SessionStore {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  private key(sessionId: string): string {
    return redisKey('session', sessionId);
  }

  private userKey(userId: UserId): string {
    return redisKey('session', 'user', userId);
  }

  async create(record: SessionRecord, ttlSec: number): Promise<void> {
    await this.redis
      .multi()
      .set(this.key(record.id), JSON.stringify(record), 'EX', ttlSec)
      .sadd(this.userKey(subjectOf(record)), record.id)
      .expire(this.userKey(subjectOf(record)), ttlSec)
      .exec();

    this.logger.debug('session.created', {
      session_id: record.id,
      kind: record.kind,
      subject: subjectOf(record),
      merchant_id: record.merchantId,
    });
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.get(this.key(sessionId));
    if (!raw) return null;

    try {
      return JSON.parse(raw) as SessionRecord;
    } catch (err) {
      // A record we cannot parse is a record we cannot trust. Drop it and re-authenticate.
      this.logger.error('session.unparseable', err, { session_id: sessionId });
      await this.destroy(sessionId);
      return null;
    }
  }

  /**
   * Sliding expiry. The `lastSeenAtMs` write is deliberately not a read-modify-write under a
   * lock — two concurrent requests racing to stamp the same second is not a correctness
   * problem, and a lock on every authenticated request is.
   */
  async touch(sessionId: string, ttlSec: number): Promise<void> {
    const record = await this.get(sessionId);
    if (!record) return;

    record.lastSeenAtMs = Date.now();
    await this.redis
      .multi()
      .set(this.key(sessionId), JSON.stringify(record), 'EX', ttlSec)
      .expire(this.userKey(subjectOf(record)), ttlSec)
      .exec();
  }

  async destroy(sessionId: string): Promise<void> {
    const record = await this.get(sessionId);
    const pipeline = this.redis.multi().del(this.key(sessionId));

    if (record) {
      pipeline.srem(this.userKey(subjectOf(record)), sessionId);
    }

    await pipeline.exec();
  }

  async destroyAllForUser(userId: UserId): Promise<number> {
    const ids = await this.redis.smembers(this.userKey(userId));
    if (ids.length === 0) return 0;

    const pipeline = this.redis.multi();
    for (const id of ids) {
      pipeline.del(this.key(id));
    }
    pipeline.del(this.userKey(userId));
    await pipeline.exec();

    this.logger.info('session.revoked_all', { user_id: userId, count: ids.length });
    return ids.length;
  }
}
