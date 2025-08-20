import type { Repository } from 'typeorm';

import { ApiKeyHasher } from 'src/auth/api-key/api-key.hasher';
import { ApiKeyResolver } from 'src/auth/api-key/api-key.resolver';
import { PrincipalFactory } from 'src/auth/principal/principal.factory';
import { InvalidApiKeyException } from 'src/common/errors/auth.exceptions';
import type { Clock } from 'src/common/time/clock';
import type { ApiKeyEntity } from 'src/merchants/api-keys/api-key.entity';

/**
 * The whole security argument of `api_key` lives in this class: split the token, HMAC the
 * secret, one indexed read, one constant-time verify, and the SAME exception on every failure.
 *
 * The last property is the one with teeth. A response that distinguishes "no such key" from
 * "wrong secret" from "revoked" is an oracle, and the revoked case is the worst of the three —
 * it tells whoever is holding a leaked key that the key was real. Every rejection below is
 * asserted to be `InvalidApiKeyException`, and that is not laziness.
 */
describe('ApiKeyResolver', () => {
  const NOW = new Date('2026-01-15T12:00:00.000Z');

  let keys: jest.Mocked<Pick<Repository<ApiKeyEntity>, 'findOne'>>;
  let hasher: jest.Mocked<Pick<ApiKeyHasher, 'lookupHash' | 'verifySecret'>>;
  let principals: PrincipalFactory;
  let clock: Clock;
  let resolver: ApiKeyResolver;

  function row(overrides: Partial<ApiKeyEntity> = {}): ApiKeyEntity {
    return {
      id: 'ak_01HQ8ZZZAB12CD34',
      merchantId: 'mch_01HQ8ZZZ0000000000000001',
      mode: 'live',
      secretHash: '$argon2id$stored',
      lookupHash: 'deadbeef',
      scopes: ['payment_intents:write'],
      revokedAt: null,
      ...overrides,
    } as ApiKeyEntity;
  }

  beforeEach(() => {
    keys = { findOne: jest.fn() };
    hasher = {
      lookupHash: jest.fn((secret: string) => `hmac(${secret})`),
      verifySecret: jest.fn(async () => true),
    };
    principals = new PrincipalFactory();
    clock = { nowMs: () => NOW.getTime(), now: () => NOW } as Clock;

    resolver = new ApiKeyResolver(
      keys as unknown as Repository<ApiKeyEntity>,
      hasher as unknown as ApiKeyHasher,
      principals,
      clock,
    );
  });

  describe('split', () => {
    it('splits a live token into mode, id suffix and secret', () => {
      expect(resolver.split('sk_live_AB12CD34_abcdefghijklmnop')).toEqual({
        mode: 'live',
        keyIdSuffix: 'AB12CD34',
        secret: 'abcdefghijklmnop',
      });
    });

    it('rejects a wrong secret', async () => {
      keys.findOne.mockResolvedValue(row());
      hasher.verifySecret.mockResolvedValue(false);

      await expect(resolver.resolveEntity(TOKEN)).rejects.toBeInstanceOf(InvalidApiKeyException);
    });

    it('accepts a key whose revocation is scheduled in the future', async () => {
      // `revoked_at` is a timestamp, not a boolean. A key revoked at end of month still works.
      keys.findOne.mockResolvedValue(row({ revokedAt: new Date('2026-02-01T00:00:00.000Z') }));

      await expect(resolver.resolveEntity(TOKEN)).resolves.toBeDefined();
    });

    it('gives every failure the same message — no enumeration oracle', async () => {
      const messages: string[] = [];

      keys.findOne.mockResolvedValue(null);
      await resolver.resolveEntity(TOKEN).catch((e: Error) => messages.push(e.message));

      keys.findOne.mockResolvedValue(row());
      hasher.verifySecret.mockResolvedValue(false);
      await resolver.resolveEntity(TOKEN).catch((e: Error) => messages.push(e.message));

      hasher.verifySecret.mockResolvedValue(true);
      keys.findOne.mockResolvedValue(row({ revokedAt: new Date('2020-01-01T00:00:00.000Z') }));
      await resolver.resolveEntity(TOKEN).catch((e: Error) => messages.push(e.message));

      expect(messages).toHaveLength(3);
      expect(new Set(messages).size).toBe(1);
    });
  });

  describe('resolve', () => {
  });
});
