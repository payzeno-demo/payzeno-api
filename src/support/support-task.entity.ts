/**
 * `support_task` — the sink for `POST /internal/v1/support-tasks` and for the two branches of
 * `LedgerEventsConsumer` that need a human.
 *
 * arc INC. When the ledger detects a duplicate settlement on a `capture_at_settlement`
 * merchant it cannot fix anything by itself: the acquirer may or may not have captured twice,
 * and only a person looking at the acquirer's portal can tell. The event carries the facts,
 * this row carries the work, and `the-incident.md` §8 is the runbook.
 *
 * `source_event_id` is UNIQUE per kind. The bus is at-least-once and the consumer's
 * `claimEvent` dedupe covers the normal path, but a redelivery after a DLQ redrive arrives
 * with the same event id through a different consumer — and 218 duplicate support tasks
 * during an incident is how the queue that is supposed to organise the response stops being
 * usable. PAY-2053.
 */
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import {
  SUPPORT_TASK_KINDS,
  SUPPORT_TASK_SEVERITIES,
  SUPPORT_TASK_STATUSES,
  type ChargeId,
  type MerchantId,
  type SupportTask,
  type SupportTaskKind,
  type SupportTaskSeverity,
  type SupportTaskStatus,
} from '@payzeno/contracts';

import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { MerchantEntity } from '../merchants/merchant.entity';

/**
 * The vocabularies moved to @payzeno/contracts when the admin back office became the first
 * reader outside this service (RFC platform-v2 §1). Re-exported so existing importers — the
 * internal route's DTO, the ledger consumer — keep their import path.
 */
export { SUPPORT_TASK_KINDS, SUPPORT_TASK_SEVERITIES, SUPPORT_TASK_STATUSES };
export type { SupportTaskKind, SupportTaskSeverity, SupportTaskStatus };

@Entity({ name: 'support_task' })
@Index('ix_support_task_merchant_created', ['merchantId', 'createdAt'])
@Index('ix_support_task_status_severity', ['status', 'severity'])
@Index('uq_support_task_source_event', ['kind', 'sourceEventId'], {
  unique: true,
  where: 'source_event_id is not null',
})
export class SupportTaskEntity extends MerchantScopedEntity {
  @ManyToOne(() => MerchantEntity)
  @JoinColumn({ name: 'merchant_id' })
  merchant?: MerchantEntity;

  @Column({ name: 'kind', type: 'text' })
  kind!: SupportTaskKind;

  @Column({ name: 'severity', type: 'text', default: 'normal' })
  severity!: SupportTaskSeverity;

  @Column({ name: 'status', type: 'text', default: 'open' })
  status!: SupportTaskStatus;

  @Column({ name: 'charge_id', type: 'text', nullable: true })
  chargeId!: ChargeId | null;

  @Column({ name: 'title', type: 'text' })
  title!: string;

  /** Free text, and it is what the support agent actually reads. Keep the facts in it. */
  @Column({ name: 'body', type: 'text' })
  body!: string;

  /** `evt_` id of the bus event that opened this. Null for manually-filed tasks. */
  @Column({ name: 'source_event_id', type: 'text', nullable: true })
  sourceEventId!: string | null;

  @Column({ name: 'assigned_to', type: 'text', nullable: true })
  assignedTo!: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote!: string | null;

  isOpen(): boolean {
    return this.status === 'open' || this.status === 'acknowledged';
  }

  /** `GET /v1/admin/support-tasks` — the full row, body and resolution included. */
  toSupportTask(): SupportTask {
    return {
      id: this.id,
      object: 'support_task',
      merchant_id: this.merchantId,
      livemode: this.livemode,
      kind: this.kind,
      severity: this.severity,
      status: this.status,
      charge_id: this.chargeId,
      title: this.title,
      body: this.body,
      assigned_to: this.assignedTo,
      resolved_at: this.resolvedAt ? this.resolvedAt.toISOString() : null,
      resolution_note: this.resolutionNote,
      created_at: this.toIsoCreatedAt(),
    };
  }

  /** The compact form, for log lines and the incident channel. */
  toSummary(): {
    id: string;
    merchant_id: MerchantId;
    kind: SupportTaskKind;
    severity: SupportTaskSeverity;
    status: SupportTaskStatus;
    charge_id: ChargeId | null;
    title: string;
    created_at: string;
  } {
    return {
      id: this.id,
      merchant_id: this.merchantId,
      kind: this.kind,
      severity: this.severity,
      status: this.status,
      charge_id: this.chargeId,
      title: this.title,
      created_at: this.toIsoCreatedAt(),
    };
  }
}
