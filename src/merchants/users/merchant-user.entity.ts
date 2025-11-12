/**
 * `merchant_user` — data-model.md §1.2. A human login on the merchant dashboard.
 *
 * Extends `BaseEntity`, not `MerchantScopedEntity`: there is no `livemode` column here and
 * there should not be. A person does not exist twice, once per mode — they log in once and
 * the mode is a property of the credential they then use.
 *
 * Email is unique PER MERCHANT (`uq_merchant_user_merchant_email`), never globally. One
 * person routinely holds a login at two merchants — accountants, agencies, marketplace
 * operators, anyone whose employer was acquired — and a global unique index also leaks tenant
 * existence, because signup collides on an address belonging to someone else's merchant.
 * `AuthService.login` therefore resolves `(email, password)` to a SET.
 */
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import type { MerchantId, UserRole } from '@payzeno/contracts';

import { BaseEntity } from '../../common/base/base.entity';
import { MerchantEntity } from '../merchant.entity';

export type MerchantUserStatus = 'active' | 'invited' | 'disabled';

@Entity({ name: 'merchant_user' })
@Index('uq_merchant_user_merchant_email', ['merchantId', 'email'], { unique: true })
@Index('ix_merchant_user_email', ['email'])
@Index('ix_merchant_user_merchant_id', ['merchantId'])
export class MerchantUserEntity extends BaseEntity {
  @Column({ name: 'merchant_id', type: 'text' })
  merchantId!: MerchantId;

  @ManyToOne(() => MerchantEntity, (merchant) => merchant.users)
  @JoinColumn({ name: 'merchant_id' })
  merchant?: MerchantEntity;

  /** `citext` in the database, so the comparison is case-insensitive without a lower(). */
  @Column({ name: 'email', type: 'citext' })
  email!: string;

  @Column({ name: 'full_name', type: 'text' })
  fullName!: string;

  /** argon2id. Never leaves this row; `AuthService` is the only reader. */
  @Column({ name: 'password_hash', type: 'text', select: false })
  passwordHash!: string;

  @Column({ name: 'role', type: 'text' })
  role!: UserRole;

  @Column({ name: 'status', type: 'text', default: 'active' })
  status!: MerchantUserStatus;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;

  canLogIn(): boolean {
    return this.status === 'active';
  }

  /** The wire shape. `password_hash` and `status` are deliberately not on it. */
  toUser(): {
    id: string;
    object: 'user';
    merchant_id: MerchantId;
    email: string;
    full_name: string;
    role: UserRole;
    last_login_at: string | null;
    created_at: string;
  } {
    return {
      id: this.id,
      object: 'user',
      merchant_id: this.merchantId,
      email: this.email,
      full_name: this.fullName,
      role: this.role,
      last_login_at: this.lastLoginAt ? this.lastLoginAt.toISOString() : null,
      created_at: this.toIsoCreatedAt(),
    };
  }
}
