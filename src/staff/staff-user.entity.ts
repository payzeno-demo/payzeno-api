/**
 * `staff_user` and `staff_audit_log` — data-model.md §1.14, migration 21.
 *
 * A PAYZENO operator is not a merchant admin. The two were the same principal until month 5,
 * and the consequence was exactly what you would expect: `POST /v1/merchants/:id/status` was
 * gated on `admin`, so a suspended merchant could un-suspend itself with its own owner login.
 * Splitting the identity is what makes `@StaffOnly()` mean anything.
 *
 * Both entities live in one file because they are one aggregate: a staff row without its
 * trail is an account nobody can hold to account. `staff_audit_log.staff_id` carries a real
 * foreign key with `on delete restrict`, which is why a staff user is disabled and never
 * deleted.
 */
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import type { StaffRole } from '@payzeno/contracts';

import { AppendOnlyEntity, BaseEntity } from '../common/base/base.entity';

export const STAFF_ROLE_VALUES: readonly StaffRole[] = ['support', 'risk', 'finance', 'admin'];

@Entity({ name: 'staff_user' })
@Index('uq_staff_user_email', ['email'], { unique: true })
@Index('pix_staff_user_active', ['role'], { where: 'disabled_at is null' })
export class StaffUser extends BaseEntity {
  /** `citext` in the database, so the unique index is case-insensitive without a lower(). */
  @Column({ type: 'citext', name: 'email' })
  email!: string;

  @Column({ type: 'text', name: 'full_name' })
  fullName!: string;

  /** argon2id. Never logged, never serialised — SerializerInterceptor drops it by name. */
  @Column({ type: 'text', name: 'password_hash' })
  passwordHash!: string;

  @Column({
    type: 'enum',
    enum: ['support', 'risk', 'finance', 'admin'],
    enumName: 'staff_role',
    name: 'role',
  })
  role!: StaffRole;

  @Column({ type: 'boolean', name: 'mfa_enrolled', default: false })
  mfaEnrolled!: boolean;

  @Column({ type: 'timestamptz', name: 'last_login_at', nullable: true })
  lastLoginAt!: Date | null;

  /** Set instead of deleting. The trail keeps its foreign key. */
  @Column({ type: 'timestamptz', name: 'disabled_at', nullable: true })
  disabledAt!: Date | null;

  isActive(): boolean {
    return this.disabledAt === null;
  }

  /**
   * `admin` satisfies any staff requirement; the other three are peers rather than a ladder.
   * A finance operator is not senior to a risk operator, they simply do different jobs.
   */
  satisfies(required: readonly StaffRole[]): boolean {
    if (!this.isActive()) {
      return false;
    }
    if (required.length === 0) {
      return true;
    }
    return this.role === 'admin' || required.includes(this.role);
  }

  /**
   * Anything that moves money or changes a merchant's standing needs a second factor.
   * `support` is read-shaped and exempt so the queue does not stall on an MFA rollout.
   */
  requiresMfa(): boolean {
    return this.role !== 'support';
  }
}

@Entity({ name: 'staff_audit_log' })
@Index('ix_staff_audit_log_staff_created', ['staffId', 'createdAt'])
@Index('ix_staff_audit_log_merchant_created', ['actingMerchantId', 'createdAt'])
export class StaffAuditLog extends AppendOnlyEntity {
  @Column({ type: 'text', name: 'staff_id' })
  staffId!: string;

  @ManyToOne(() => StaffUser, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'staff_id' })
  staff?: StaffUser;

  /** The merchant the operator was acting on behalf of. Null for platform-wide actions. */
  @Column({ type: 'text', name: 'acting_merchant_id', nullable: true })
  actingMerchantId!: string | null;

  @Column({ type: 'text', name: 'action' })
  action!: string;

  @Column({ type: 'text', name: 'resource_type' })
  resourceType!: string;

  @Column({ type: 'text', name: 'resource_id', nullable: true })
  resourceId!: string | null;

  @Column({ type: 'jsonb', name: 'before', nullable: true })
  before!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', name: 'after', nullable: true })
  after!: Record<string, unknown> | null;

  /**
   * Free text from the request body. Risk and finance actions are reviewed monthly and a
   * blank reason is what the reviewer bounces, so the column is captured even though the
   * schema does not force it.
   */
  @Column({ type: 'text', name: 'reason', nullable: true })
  reason!: string | null;

  @Column({ type: 'text', name: 'request_id', nullable: true })
  requestId!: string | null;

  @Column({ type: 'inet', name: 'ip', nullable: true })
  ip!: string | null;

  describe(): string {
    const scope = this.actingMerchantId ? ` on ${this.actingMerchantId}` : '';
    return `${this.staffId} ${this.action}${scope}`;
  }
}
