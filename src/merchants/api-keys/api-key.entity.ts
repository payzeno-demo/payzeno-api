/**
 * `api_key` — data-model.md §1.3.
 *
 * TWO hashes, on purpose:
 *
 *   lookup_hash  HMAC-SHA256(secret, API_KEY_PEPPER), deterministic, `uq_api_key_lookup_hash`
 *                — this is what makes `ApiKeyResolver` an O(1) index lookup.
 *   secret_hash  argon2id, salted, for the constant-time verify.
 *
 * A unique index on a salted argon2id hash is meaningless, and argon2-verifying every row in
 * the table until one matches is not an authentication design.
 *
 * The prefix is `sk_`, never `pk_`. `pk_` means *publishable* everywhere else in the industry
 * and a merchant who reads it that way ships a server bearer credential in browser JavaScript.
 */
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import type { ApiKeyMode, ApiKeyScope, MerchantId } from '@payzeno/contracts';

import { MerchantScopedEntity } from '../../common/base/merchant-scoped.entity';
import { MerchantEntity } from '../merchant.entity';

@Entity({ name: 'api_key' })
@Index('ix_api_key_merchant_id', ['merchantId'])
@Index('uq_api_key_lookup_hash', ['lookupHash'], { unique: true })
@Index('pix_api_key_active', ['merchantId'], { where: 'revoked_at is null' })
export class ApiKeyEntity extends MerchantScopedEntity {
  @ManyToOne(() => MerchantEntity, (merchant) => merchant.apiKeys)
  @JoinColumn({ name: 'merchant_id' })
  merchant?: MerchantEntity;

  /** Merchant-chosen label. Shown in the console key list and in nothing else. */
  @Column({ name: 'name', type: 'text' })
  name!: string;

  @Column({ name: 'mode', type: 'text' })
  mode!: ApiKeyMode;

  /** `sk_live_` / `sk_test_`. Stored so the console can render it without the secret. */
  @Column({ name: 'prefix', type: 'varchar', length: 12 })
  prefix!: string;

  @Column({ name: 'lookup_hash', type: 'char', length: 64 })
  lookupHash!: string;

  @Column({ name: 'secret_hash', type: 'text', select: false })
  secretHash!: string;

  @Column({ name: 'last_four', type: 'char', length: 4 })
  lastFour!: string;

  /**
   * Migration 19 (ystackoverflow, three review rounds). The vocabulary is `API_KEY_SCOPES`
   * and `@RequiredScopes(...)` is its only reader — without a declared vocabulary this column
   * has nothing checking it and every key is effectively unrestricted.
   */
  @Column({ name: 'scopes', type: 'text', array: true, default: () => "'{}'" })
  scopes!: ApiKeyScope[];

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  isRevoked(now: Date): boolean {
    return this.revokedAt !== null && this.revokedAt <= now;
  }

  /** The wire shape. Neither hash is on it and neither ever will be. */
  toApiKey(): {
    id: string;
    object: 'api_key';
    merchant_id: MerchantId;
    name: string;
    mode: ApiKeyMode;
    prefix: string;
    last_four: string;
    scopes: ApiKeyScope[];
    created_at: string;
    revoked_at: string | null;
  } {
    return {
      id: this.id,
      object: 'api_key',
      merchant_id: this.merchantId,
      name: this.name,
      mode: this.mode,
      prefix: this.prefix,
      last_four: this.lastFour,
      scopes: [...this.scopes],
      created_at: this.toIsoCreatedAt(),
      revoked_at: this.revokedAt ? this.revokedAt.toISOString() : null,
    };
  }
}

/**
 * Pre-migration-22 lookup. Before `lookup_hash` existed, resolving a presented token meant
 * loading every non-revoked key for… nobody, because the token does not say which merchant it
 * belongs to. It was a full scan plus an argon2 verify per row and it is the reason
 * authentication showed up in the p99 flame graph.
 *
 * Kept as a comment rather than as code because deleting it loses the explanation of why
 * there are two hash columns, and every six months somebody proposes dropping one.
 *
 *   findBySecretHash(secret: string): Promise<ApiKeyEntity | null> {
 *     const candidates = await this.find({ where: { revokedAt: IsNull() } });
 *     for (const candidate of candidates) {
 *       if (await argon2.verify(candidate.secretHash, secret)) return candidate;
 *     }
 *     return null;
 *   }
 */
