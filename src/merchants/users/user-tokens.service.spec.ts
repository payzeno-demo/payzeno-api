import type { EntityManager } from 'typeorm';

import { InvalidLinkTokenException } from 'src/common/errors/identity.exceptions';
import { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import { MerchantUserTokenEntity } from 'src/merchants/users/merchant-user-token.entity';
import type { MerchantUserTokenRepository } from 'src/merchants/users/merchant-user-token.repository';
import { hashToken, MerchantUserTokensService, TOKEN_TTL_SECONDS } from 'src/merchants/users/user-tokens.service';

import { FixedClock } from 'test/support/fixed-clock';

/**
 * The emailed-link secrets. Four properties carry the security of signup, invites and resets:
 * the plaintext is never stored; a new link revokes the old one; a link works once, for its own
 * purpose, until it expires; and two clicks racing on one link have exactly one winner.
 */
describe('MerchantUserTokensService', () => {
  const clock = new FixedClock('2026-05-02T11:30:00.000Z');
  const manager = { tx: true } as unknown as EntityManager;
  const subject = { id: 'usr_01HZUSER00000000000000001', merchantId: 'mch_01HZMERCH0000000000000001' };

  let tokens: { append: jest.Mock; revokeLive: jest.Mock; findByHash: jest.Mock; consume: jest.Mock };
  let service: MerchantUserTokensService;

  function stored(overrides: Partial<MerchantUserTokenEntity> = {}): MerchantUserTokenEntity {
    const row = new MerchantUserTokenEntity();
    Object.assign(row, {
      id: 'tok_1',
      purpose: 'password_reset',
      tokenHash: hashToken('raw'),
      merchantId: subject.merchantId,
      userId: subject.id,
      expiresAt: clock.plusSeconds(600),
      consumedAt: null,
      ...overrides,
    });
    return row;
  }

  beforeEach(() => {
    tokens = {
      append: jest.fn().mockResolvedValue(undefined),
      revokeLive: jest.fn().mockResolvedValue(1),
      findByHash: jest.fn().mockResolvedValue(stored()),
      consume: jest.fn().mockResolvedValue(1),
    };
    service = new MerchantUserTokensService(
      tokens as unknown as MerchantUserTokenRepository,
      new IdFactory(),
      clock,
      new NoopLogger(),
    );
  });

  describe('issue', () => {
    it('stores only the SHA-256 of a 256-bit secret', async () => {
      const raw = await service.issue(subject, 'invitation', manager);

      const [row] = tokens.append.mock.calls[0] as [MerchantUserTokenEntity];
      expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(row.tokenHash).toBe(hashToken(raw));
      expect(row.tokenHash).not.toContain(raw);
      expect(row.id).toMatch(/^tok_/);
    });

    it.each([
      ['email_verification', 72 * 3_600],
      ['invitation', 72 * 3_600],
      ['password_reset', 3_600],
    ] as const)('gives %s links %i seconds', async (purpose, seconds) => {
      await service.issue(subject, purpose, manager);

      const [row] = tokens.append.mock.calls[0] as [MerchantUserTokenEntity];
      expect(TOKEN_TTL_SECONDS[purpose]).toBe(seconds);
      expect(row.expiresAt).toEqual(clock.plusSeconds(seconds));
    });

    it('revokes the older live links of the same purpose first, in the same transaction', async () => {
      await service.issue(subject, 'password_reset', manager);

      expect(tokens.revokeLive).toHaveBeenCalledWith(subject.id, 'password_reset', clock.now(), manager);
      expect(tokens.revokeLive.mock.invocationCallOrder[0]).toBeLessThan(tokens.append.mock.invocationCallOrder[0]);
      expect(tokens.append).toHaveBeenCalledWith(expect.any(MerchantUserTokenEntity), manager);
    });
  });

  describe('consume', () => {
    it('spends a live link and returns whose it was', async () => {
      const row = await service.consume('raw', 'password_reset', manager);

      expect(tokens.findByHash).toHaveBeenCalledWith(hashToken('raw'), manager);
      expect(tokens.consume).toHaveBeenCalledWith('tok_1', clock.now(), manager);
      expect(row).toMatchObject({ userId: subject.id, merchantId: subject.merchantId, consumedAt: clock.now() });
    });

    it('is token_invalid for an unknown secret', async () => {
      tokens.findByHash.mockResolvedValue(null);

      await expect(service.consume('nope', 'password_reset', manager)).rejects.toMatchObject({ reason: 'token_invalid' });
    });

    it('is token_invalid for a link issued for a different flow', async () => {
      await expect(service.consume('raw', 'invitation', manager)).rejects.toMatchObject({ reason: 'token_invalid' });
      expect(tokens.consume).not.toHaveBeenCalled();
    });

    it('is token_invalid for a link already used (or superseded)', async () => {
      tokens.findByHash.mockResolvedValue(stored({ consumedAt: clock.now() }));

      await expect(service.consume('raw', 'password_reset', manager)).rejects.toMatchObject({ reason: 'token_invalid' });
    });

    it('is token_expired only for a genuine, unused, expired link', async () => {
      tokens.findByHash.mockResolvedValue(stored({ expiresAt: clock.plusSeconds(-1) }));

      const err = await service.consume('raw', 'password_reset', manager).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(InvalidLinkTokenException);
      expect(err).toMatchObject({ reason: 'token_expired', httpStatus: 400 });
    });

    it('loses a race to a concurrent click as token_invalid', async () => {
      tokens.consume.mockResolvedValue(0);

      await expect(service.consume('raw', 'password_reset', manager)).rejects.toMatchObject({ reason: 'token_invalid' });
    });
  });
});
