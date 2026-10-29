import { Redis } from 'ioredis';

import type { ApiConfig } from 'src/config/api-config.type';
import { connectRedisClient } from 'src/config/redis.config';

function config(): ApiConfig {
  return { redis: { url: 'redis://127.0.0.1:1', keyPrefix: 'pz:api:' } } as ApiConfig;
}

/** A real client (lazyConnect opens nothing until `connect`), with `connect` itself stubbed. */
describe('connectRedisClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('connects before handing the client out', async () => {
    // Regression: with lazyConnect and no offline queue the first command after boot failed
    // ("Stream isn't writeable") — the first /healthz was a 500 and every job's first tick errored.
    const connect = jest.spyOn(Redis.prototype, 'connect').mockResolvedValue(undefined);

    const client = await connectRedisClient(config());
    client.disconnect();

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('still hands the client out when Redis is down at boot', async () => {
    jest.spyOn(Redis.prototype, 'connect').mockRejectedValue(new Error('connect ECONNREFUSED'));

    const client = await connectRedisClient(config());
    client.disconnect();

    expect(client).toBeInstanceOf(Redis);
  });
});
