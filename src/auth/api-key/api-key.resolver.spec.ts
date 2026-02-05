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

    it('splits a test token', () => {
      expect(resolver.split('sk_test_AB12CD34_abcdefghijklmnop')?.mode).toBe('test');
    });

    it('tolerates surrounding whitespace', () => {
      expect(resolver.split('  sk_live_AB12CD34_abcdefghijklmnop  ')).not.toBeNull();
    });

    it.each([
      ['a session cookie value', 'ZmFrZS1zZXNzaW9uLWlk'],
      ['a client secret', 'pi_01HQ8ZZZ_secret_abc'],
      ['the pk_ prefix nobody should be using', 'pk_live_AB12CD34_abcdefghijklmnop'],
      ['a truncated secret', 'sk_live_AB12CD34_short'],
      ['no secret segment at all', 'sk_live_AB12CD34'],
      ['the empty string', ''],
    ])('returns null for %s', (_label, token) => {
      expect(resolver.split(token)).toBeNull();
    });
  });

  describe('resolveEntity', () => {
    const TOKEN = 'sk_live_AB12CD34_abcdefghijklmnop';

    it('looks the key up by the HMAC of the secret, not by the id suffix', async () => {
      keys.findOne.mockResolvedValue(row());

      await resolver.resolveEntity(TOKEN);

      expect(hasher.lookupHash).toHaveBeenCalledWith('abcdefghijklmnop');
      expect(keys.findOne).toHaveBeenCalledWith({
        where: { lookupHash: 'hmac(abcdefghijklmnop)' },
      });
    });

    it('verifies the secret against the stored argon2 hash', async () => {
      keys.findOne.mockResolvedValue(row());

      await resolver.resolveEntity(TOKEN);

      expect(hasher.verifySecret).toHaveBeenCalledWith('$argon2id$stored', 'abcdefghijklmnop');
    });

    it('returns the row on success', async () => {
      const entity = row();
      keys.findOne.mockResolvedValue(entity);

      await expect(resolver.resolveEntity(TOKEN)).resolves.toBe(entity);
    });

    it('rejects a malformed token without touching the database', async () => {
      await expect(resolver.resolveEntity('garbage')).rejects.toBeInstanceOf(InvalidApiKeyException);

      expect(keys.findOne).not.toHaveBeenCalled();
    });

    it('rejects an unknown key', async () => {
      keys.findOne.mockResolvedValue(null);

      await expect(resolver.resolveEntity(TOKEN)).rejects.toBeInstanceOf(InvalidApiKeyException);
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

    it('rejects a sk_test_ token whose row is a live key', async () => {
      keys.findOne.mockResolvedValue(row({ mode: 'live' }));

      await expect(
        resolver.resolveEntity('sk_test_AB12CD34_abcdefghijklmnop'),
      ).rejects.toBeInstanceOf(InvalidApiKeyException);
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
    it('is derived from the secret HMAC and is stable per key', () => {
      const first = resolver.bucketKeyFor('sk_live_AB12CD34_abcdefghijklmnop');
      const second = resolver.bucketKeyFor('sk_live_ZZZZZZZZ_abcdefghijklmnop');

      // The id suffix is decoration; the bucket follows the secret.
      expect(first).toBe(second);
      expect(first).toHaveLength(16);
    });

    it('is null for something that is not a Payzeno key', () => {
      expect(resolver.bucketKeyFor('Bearer nonsense')).toBeNull();
    });

  });
});
