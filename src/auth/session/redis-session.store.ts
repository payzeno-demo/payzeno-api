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
