/**
 * MerchantUserTokensService — issue and spend the secrets behind emailed links.
 *
 *   email_verification  72h  signup → `POST /v1/signup/verify`
 *   invitation          72h  invite → `POST /v1/auth/invitations/accept`
 *   password_reset       1h  reset  → `POST /v1/auth/password/reset/confirm`
 *
 * Issuing a new link of a purpose revokes every older live one for the same user, so "send it
 * again" never leaves two working links in two inboxes. Both methods take the caller's
 * EntityManager: the token, the user change it authorises and the email that carries it commit
 * or roll back together.
 *
 * The plaintext is 32 random bytes, base64url; only its SHA-256 is stored. 256 bits of entropy
 * needs no slow hash — there is nothing to brute-force that is not already the whole keyspace.
 */
import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { MerchantId, UserId } from '@payzeno/contracts';

import { InvalidLinkTokenException } from '../../common/errors/identity.exceptions';
import { IdFactory } from '../../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { CLOCK, type Clock } from '../../common/time/clock';

import { MerchantUserTokenEntity, type MerchantUserTokenPurpose } from './merchant-user-token.entity';
import { MerchantUserTokenRepository } from './merchant-user-token.repository';

export const TOKEN_TTL_SECONDS: Readonly<Record<MerchantUserTokenPurpose, number>> = {
  email_verification: 72 * 3_600,
  invitation: 72 * 3_600,
  password_reset: 3_600,
};

export interface TokenSubject {
  id: UserId;
  merchantId: MerchantId;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

@Injectable()
export class MerchantUserTokensService {
  constructor(
    private readonly tokens: MerchantUserTokenRepository,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /** Returns the plaintext secret. It goes into an email and nowhere else. */
  async issue(subject: TokenSubject, purpose: MerchantUserTokenPurpose, manager: EntityManager): Promise<string> {
    const now = this.clock.now();
    const raw = randomBytes(32).toString('base64url');

    const superseded = await this.tokens.revokeLive(subject.id, purpose, now, manager);

    const row = new MerchantUserTokenEntity();
    row.id = this.ids.opaque('tok_');
    row.purpose = purpose;
    row.tokenHash = hashToken(raw);
    row.merchantId = subject.merchantId;
    row.userId = subject.id;
    row.expiresAt = this.clock.plusSeconds(TOKEN_TTL_SECONDS[purpose]);
    row.consumedAt = null;
    row.createdAt = now;
    row.updatedAt = now;
    await this.tokens.append(row, manager);

    this.logger.info('merchant_user_token.issued', {
      token_id: row.id,
      purpose,
      user_id: subject.id,
      merchant_id: subject.merchantId,
      superseded,
    });
    return raw;
  }

  /**
   * Spends `raw` for `purpose` and returns the row (whose `userId`/`merchantId` say who it was
   * for). Throws `InvalidLinkTokenException` — `token_expired` only for a genuine, unused,
   * expired link of the right purpose; everything else is `token_invalid`.
   */
  async consume(
    raw: string,
    purpose: MerchantUserTokenPurpose,
    manager: EntityManager,
  ): Promise<MerchantUserTokenEntity> {
    const now = this.clock.now();
    const row = await this.tokens.findByHash(hashToken(raw.trim()), manager);

    if (!row || row.purpose !== purpose || row.consumedAt !== null) {
      throw new InvalidLinkTokenException('token_invalid');
    }
    if (row.isExpiredAt(now)) {
      throw new InvalidLinkTokenException('token_expired');
    }
    if ((await this.tokens.consume(row.id, now, manager)) === 0) {
      // Lost the race to a concurrent click on the same link.
      throw new InvalidLinkTokenException('token_invalid');
    }

    this.logger.info('merchant_user_token.consumed', {
      token_id: row.id,
      purpose,
      user_id: row.userId,
      merchant_id: row.merchantId,
    });
    row.consumedAt = now;
    return row;
  }
}
