import { createHmac } from 'node:crypto';

import * as argon2 from 'argon2';

import { ApiKeyHasher } from 'src/auth/api-key/api-key.hasher';
import type { ApiConfig } from 'src/config/api-config.type';

/**
 * `argon2` is mocked. Real argon2id at m=64MB t=3 costs ~90ms per call and this file makes
 * eleven of them — a minute of CI time to re-prove a property the argon2 package already
 * tests. What IS ours, and what is asserted here for real, is the two-hash design:
 * `lookup_hash` is a deterministic HMAC with a pepper (so the unique index works) and
 * `secret_hash` is the salted verify. Getting those two the wrong way round is the failure
 * mode this file exists to catch. — osquash
 */
jest.mock('argon2', () => ({
  argon2id: 2,
  hash: jest.fn(async (secret: string) => `$argon2id$fake$${secret}`),
  verify: jest.fn(async (stored: string, presented: string) => stored === `$argon2id$fake$${presented}`),
}));

const PEPPER = 'pepper-for-the-test-environment-only';

function config(pepper = PEPPER): ApiConfig {
  return { auth: { apiKeyPepper: pepper } } as unknown as ApiConfig;
}

describe('ApiKeyHasher', () => {
  let hasher: ApiKeyHasher;

  beforeEach(() => {
    jest.clearAllMocks();
    hasher = new ApiKeyHasher(config());
  });

  describe('lookupHash', () => {
    it('is HMAC-SHA256 of the secret under the pepper', () => {
      const expected = createHmac('sha256', PEPPER).update('s3cr3t').digest('hex');

      expect(hasher.lookupHash('s3cr3t')).toBe(expected);
    });

    it('verifies the secret it hashed', async () => {
      const stored = await hasher.hashSecret('s3cr3t');

      await expect(hasher.verifySecret(stored, 's3cr3t')).resolves.toBe(true);
    });

    it('rejects a wrong secret', async () => {
      const stored = await hasher.hashSecret('s3cr3t');

      await expect(hasher.verifySecret(stored, 'not-it')).resolves.toBe(false);
    });

    it('never mints the same secret twice', async () => {
      const [a, b] = await Promise.all([hasher.mint(), hasher.mint()]);

      expect(a.secret).not.toBe(b.secret);
    });

    it('produces a URL-safe secret — it travels in an Authorization header', async () => {
      const minted = await hasher.mint();

      expect(minted.secret).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('formatToken', () => {
    it('is sk_<mode>_<id suffix>_<secret>', () => {
      const token = hasher.formatToken('live', 'ak_01HQ8ZZZAB12CD34', 'the-secret-part');

      expect(token).toBe('sk_live_AB12CD34_the-secret-part');
    });

    it('is true for equal strings', () => {
      expect(ApiKeyHasher.constantTimeEquals('abc123', 'abc123')).toBe(true);
    });

  });
});
