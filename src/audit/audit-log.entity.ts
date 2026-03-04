/**
 * `audit_log` — data-model.md §1.13.
 *
 * Append-only, so it extends AppendOnlyEntity and not BaseEntity: there is no `updated_at`
 * column and no `set_updated_at()` trigger on this table. An audit row that can be updated
 * is not an audit row.
 *
 * `merchant_id` is nullable, which is why this is not a MerchantScopedEntity — a
 * platform-level action (a staff user creating a merchant, an internal service reporting a
 * duplicate settlement for an orphaned item) has no tenant yet.
 */
import { Column, Entity, Index } from 'typeorm';

import type { AuditActorType } from '@payzeno/contracts';

import { AppendOnlyEntity } from '../common/base/base.entity';

@Entity({ name: 'audit_log' })
@Index('ix_audit_log_merchant_created', ['merchantId', 'createdAt'])
@Index('ix_audit_log_resource', ['resourceType', 'resourceId'])
export class AuditLog extends AppendOnlyEntity {
  @Column({ type: 'text', name: 'merchant_id', nullable: true })
  merchantId!: string | null;

  @Column({
    type: 'enum',
    enum: ['user', 'api_key', 'staff', 'internal_service', 'system'],
    enumName: 'audit_actor_type',
    name: 'actor_type',
  })
  actorType!: AuditActorType;

  /** `usr_`, `key_`, `stf_`, or a service name for `internal_service`/`system`. */
  @Column({ type: 'text', name: 'actor_id', nullable: true })
  actorId!: string | null;

  /** Dotted `<resource>.<verb>`. Indexed vocabulary — keep it small. */
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

  @Column({ type: 'text', name: 'request_id', nullable: true })
  requestId!: string | null;

  @Column({ type: 'inet', name: 'ip', nullable: true })
  ip!: string | null;

  /** Added by migration 31 with the rest of the merchant-scoped tables. */
  @Column({ type: 'boolean', name: 'livemode', default: false })
  livemode!: boolean;

  /** What the console's activity feed renders; the raw diff stays server-side. */
  summary(): string {
    return `${this.action} ${this.resourceType}${this.resourceId ? `:${this.resourceId}` : ''}`;
  }

  /** True when the row records a change rather than a read-shaped action. */
  hasDiff(): boolean {
    return this.before !== null || this.after !== null;
  }
}
