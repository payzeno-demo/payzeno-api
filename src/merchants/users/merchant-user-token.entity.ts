/**
 * `merchant_user_token` — the single-use secret behind every emailed link that lets a person
 * back in (RFC platform-v2 §3-§4, migration 1731100000000).
 *
 * The row holds the SHA-256 of the secret, never the secret. `MerchantUserTokensService` is the
 * only writer and the only place the plaintext exists, for exactly as long as it takes to put
 * it in an email.
 */
import { Column, Entity, Index } from 'typeorm';

import type { MerchantId, UserId } from '@payzeno/contracts';

import { BaseEntity } from '../../common/base/base.entity';

export const MERCHANT_USER_TOKEN_PURPOSES = ['email_verification', 'invitation', 'password_reset'] as const;
export type MerchantUserTokenPurpose = (typeof MERCHANT_USER_TOKEN_PURPOSES)[number];

@Entity({ name: 'merchant_user_token' })
@Index('uq_merchant_user_token_hash', ['tokenHash'], { unique: true })
@Index('pix_merchant_user_token_live', ['userId', 'purpose'], { where: 'consumed_at is null' })
export class MerchantUserTokenEntity extends BaseEntity {
  @Column({ name: 'purpose', type: 'text' })
  purpose!: MerchantUserTokenPurpose;

  /** Hex SHA-256 of the emailed secret. */
  @Column({ name: 'token_hash', type: 'text' })
  tokenHash!: string;

  @Column({ name: 'merchant_id', type: 'text' })
  merchantId!: MerchantId;

  @Column({ name: 'user_id', type: 'text' })
  userId!: UserId;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  /** Set when the link is used — and when a newer link of the same purpose supersedes it. */
  @Column({ name: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt!: Date | null;

  isExpiredAt(now: Date): boolean {
    return this.expiresAt.getTime() <= now.getTime();
  }
}
