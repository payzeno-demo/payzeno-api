/**
 * RedisLockService — SET NX PX with a fencing token.
 *
 * Release and extend are Lua compare-and-act, not GET-then-DEL. A plain DEL after a GET
 * deletes somebody else's lease when our own expired between the two commands, and that is
 * how two tasks ended up draining the outbox on the same tick in month 4.
 *
 * This is not Redlock. One Redis, one lease, and the jobs are all idempotent enough to
 * survive a lost lease — see docs/runbooks/payzeno-api.md, "job lease expired".
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

import { redisKey, REDIS_CLIENT } from '../../config/redis.config';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../logging/logger';

import type { DistributedLock, LockHandle } from './distributed-lock';

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const EXTEND_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

@Injectable()
export class RedisLockService implements DistributedLock {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  private key(name: string): string {
    return redisKey('jobLock', name);
  }

  async acquire(name: string, ttlSec: number): Promise<LockHandle | null> {
    const token = randomUUID();
    const result = await this.redis.set(this.key(name), token, 'PX', ttlSec * 1000, 'NX');

    if (result !== 'OK') {
      this.logger.debug('lock not acquired', { lock: name });
      return null;
    }

    return { name, token, expiresAtMs: Date.now() + ttlSec * 1000 };
  }

  async release(handle: LockHandle): Promise<boolean> {
    const released = (await this.redis.eval(
      RELEASE_SCRIPT,
      1,
      this.key(handle.name),
      handle.token,
    )) as number;

    if (released !== 1) {
      // We ran past our own lease. The job's work is done either way; the next tick is safe.
      this.logger.warn('lock lease had already lapsed on release', { lock: handle.name });
    }

    return released === 1;
  }

  async extend(handle: LockHandle, ttlSec: number): Promise<boolean> {
    const extended = (await this.redis.eval(
      EXTEND_SCRIPT,
      1,
      this.key(handle.name),
      handle.token,
      String(ttlSec * 1000),
    )) as number;

    if (extended === 1) {
      handle.expiresAtMs = Date.now() + ttlSec * 1000;
    }

    return extended === 1;
  }
}
