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

    it('is deterministic — the unique index depends on it', () => {
      expect(hasher.lookupHash('s3cr3t')).toBe(hasher.lookupHash('s3cr3t'));
    });

    it('changes completely when the pepper rotates', () => {
      const rotated = new ApiKeyHasher(config('a-different-pepper'));

      // This is why rotating API_KEY_PEPPER invalidates every live key in the environment.
      expect(rotated.lookupHash('s3cr3t')).not.toBe(hasher.lookupHash('s3cr3t'));
    });

    it('separates two secrets that differ by one character', () => {
      expect(hasher.lookupHash('s3cr3t')).not.toBe(hasher.lookupHash('s3cr3T'));
    });
  });

  describe('hashSecret / verifySecret', () => {
    it('hashes with argon2id at the OWASP baseline', async () => {
      await hasher.hashSecret('s3cr3t');

      expect(argon2.hash).toHaveBeenCalledWith(
        's3cr3t',
        expect.objectContaining({ memoryCost: 65_536, timeCost: 3, parallelism: 4 }),
      );
    });

    it('verifies the secret it hashed', async () => {
      const stored = await hasher.hashSecret('s3cr3t');

      await expect(hasher.verifySecret(stored, 's3cr3t')).resolves.toBe(true);
    });

    it('rejects a wrong secret', async () => {
      const stored = await hasher.hashSecret('s3cr3t');

      await expect(hasher.verifySecret(stored, 'not-it')).resolves.toBe(false);
    });

    it('verifies with the digest alone — the parameters live in the stored hash', async () => {
      const stored = await hasher.hashSecret('s3cr3t');
      await hasher.verifySecret(stored, 's3cr3t');

      // Regression: argon2 0.40's verify rejects the hashing options ("Invalid argument"), and
      // verifySecret's catch turned that into `false` for every key ever minted.
      expect(argon2.verify).toHaveBeenCalledWith(stored, 's3cr3t');
    });

    it('round-trips through the real argon2 package', async () => {
      // One real hash + verify (~0.2s) so the mock above cannot hide a call the package rejects.
      const real = jest.requireActual<typeof import('argon2')>('argon2');
      (argon2.hash as jest.Mock).mockImplementationOnce(real.hash);
      (argon2.verify as jest.Mock).mockImplementationOnce(real.verify).mockImplementationOnce(real.verify);

      const stored = await hasher.hashSecret('s3cr3t');

      await expect(hasher.verifySecret(stored, 's3cr3t')).resolves.toBe(true);
      await expect(hasher.verifySecret(stored, 's3cr3T')).resolves.toBe(false);
    });

    it('returns false rather than throwing on a corrupt stored hash', async () => {
      (argon2.verify as jest.Mock).mockRejectedValueOnce(new Error('pchstr'));

      // A corrupt row must fail authentication, not take the endpoint down for every caller.
      await expect(hasher.verifySecret('not-a-hash', 'anything')).resolves.toBe(false);
    });
  });

  describe('mint', () => {
    it('returns a secret with both of its hashes and the display suffix', async () => {
      const minted = await hasher.mint();

      expect(minted.secret).toHaveLength(32); // 24 bytes, base64url
      expect(minted.lookupHash).toBe(hasher.lookupHash(minted.secret));
      expect(minted.secretHash).toBe(`$argon2id$fake$${minted.secret}`);
      expect(minted.lastFour).toBe(minted.secret.slice(-4));
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

    it('uses sk_ for test mode too — pk_ would read as publishable', () => {
      // A merchant who reads `pk_` ships a server bearer credential in browser JavaScript.
      expect(hasher.formatToken('test', 'ak_01HQ8ZZZAB12CD34', 'x')).toMatch(/^sk_test_/);
    });
  });

  describe('constantTimeEquals', () => {
    it('is true for equal strings', () => {
      expect(ApiKeyHasher.constantTimeEquals('abc123', 'abc123')).toBe(true);
    });

    it('is false for different strings of the same length', () => {
      expect(ApiKeyHasher.constantTimeEquals('abc123', 'abc124')).toBe(false);
    });

    it('is false — not a throw — for different lengths', () => {
      // timingSafeEqual throws on a length mismatch; the guard callers must get a boolean.
      expect(ApiKeyHasher.constantTimeEquals('abc', 'abcdef')).toBe(false);
    });

    it('handles the empty string', () => {
      expect(ApiKeyHasher.constantTimeEquals('', '')).toBe(true);
      expect(ApiKeyHasher.constantTimeEquals('', 'x')).toBe(false);
    });
  });
});
