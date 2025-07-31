import type { ApiKeyHasher } from 'src/auth/api-key/api-key.hasher';
import { DEFAULT_SCOPES, READ_SCOPES, WRITE_SCOPES } from 'src/auth/api-key/api-key.scopes';
import type { MerchantScope } from 'src/common/base/merchant-scoped.entity';
import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import { ApiKeysService, type ApiKeyRepository } from 'src/merchants/api-keys/api-keys.service';

import { TEST_API_KEY_ID, TEST_MERCHANT_ID } from 'test/factories/ids';
import { FixedClock } from 'test/support/fixed-clock';

/**
 * The plaintext secret exists for exactly one function call.
 *
 * `create()` returns it once in `CreateApiKeyResponse.secret` and nothing stores it: the row
 * holds `lookup_hash` (HMAC, for the O(1) lookup that `ApiKeyResolver` does) and
 * `secret_hash` (argon2id, for the verify). The first test below is the one that would catch
 * a refactor putting the secret back on the entity.
 *
 * arc RAMP — ystackoverflow's directory. The default-scope behaviour is his PAY-2071 change:
 * migration 19's column default is `'{}'`, which would authorise nothing.
 */
describe('ApiKeysService', () => {
  const clock = new FixedClock('2026-04-01T12:00:00.000Z');
  const scope: MerchantScope = { merchantId: TEST_MERCHANT_ID, livemode: true };

  let keys: {
    insertMapped: jest.Mock;
    revoke: jest.Mock;
    findScoped: jest.Mock;
    paginateCursor: jest.Mock;
    listActive: jest.Mock;
  };
  let hasher: { mint: jest.Mock; formatToken: jest.Mock };
  let service: ApiKeysService;

  function storedKey(overrides: Record<string, unknown> = {}) {
    return {
      id: TEST_API_KEY_ID,
      merchantId: TEST_MERCHANT_ID,
      name: 'Production server',
      mode: 'live',
      prefix: 'sk_live_',
      lastFour: 'a91f',
      scopes: [...READ_SCOPES],
      livemode: true,
      revokedAt: null,
      toApiKey: () => ({
        id: TEST_API_KEY_ID,
        object: 'api_key' as const,
        merchant_id: TEST_MERCHANT_ID,
        name: 'Production server',
        mode: 'live' as const,
        prefix: 'sk_live_',
        last_four: 'a91f',
        scopes: [...READ_SCOPES],
        created_at: '2026-04-01T12:00:00.000Z',
        revoked_at: null,
      }),
      ...overrides,
    };
  }

  beforeEach(() => {
    keys = {
      insertMapped: jest.fn().mockResolvedValue(undefined),
      revoke: jest.fn().mockResolvedValue(1),
      findScoped: jest.fn().mockResolvedValue(storedKey()),
      paginateCursor: jest
        .fn()
        .mockResolvedValue({ data: [storedKey()], has_more: false, next_cursor: null }),
      listActive: jest.fn().mockResolvedValue([storedKey()]),
    };

    hasher = {
      mint: jest.fn().mockResolvedValue({
        secret: 'the-plaintext-secret-value-abc',
        lookupHash: 'lookup-hash-hex',
        secretHash: '$argon2id$v=19$...',
        lastFour: 'eabc',
      }),
      formatToken: jest.fn(
        (mode: string, id: string, secret: string) => `sk_${mode}_${id.slice(-8)}_${secret}`,
      ),
    };

    service = new ApiKeysService(
      keys as unknown as ApiKeyRepository,
      hasher as unknown as ApiKeyHasher,
      new IdFactory(),
      clock,
      new NoopLogger(),
    );
  });

  it('names the aggregate', () => {
    expect(service.entityName).toBe('api_key');
  });

  describe('create', () => {
    const request = { name: '  Production server  ', mode: 'live' as const };

    it('reads through the tenant-scoped find', async () => {
      const key = await service.get(scope, TEST_API_KEY_ID);

      expect(keys.findScoped).toHaveBeenCalledWith(TEST_API_KEY_ID, scope);
      expect(key.object).toBe('api_key');
    });

    it('404s an unknown key and an already-revoked one alike', async () => {
      keys.revoke.mockResolvedValue(0);

      await expect(service.revoke(TEST_MERCHANT_ID, TEST_API_KEY_ID)).rejects.toBeInstanceOf(
        ResourceNotFoundException,
      );
    });
  });
});
