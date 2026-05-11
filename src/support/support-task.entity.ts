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

import type { ChargeId, MerchantId } from '@payzeno/contracts';

import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { MerchantEntity } from '../merchants/merchant.entity';

export const SUPPORT_TASK_KINDS = [
  'duplicate_settlement',
  'ledger_imbalance',
  'settlement_variance',
  'payout_returned',
  'dunning_escalation',
  'manual_review',
] as const;
export type SupportTaskKind = (typeof SUPPORT_TASK_KINDS)[number];

export const SUPPORT_TASK_SEVERITIES = ['low', 'normal', 'high', 'critical'] as const;
export type SupportTaskSeverity = (typeof SUPPORT_TASK_SEVERITIES)[number];

export const SUPPORT_TASK_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;
export type SupportTaskStatus = (typeof SUPPORT_TASK_STATUSES)[number];

@Entity({ name: 'support_task' })
@Index('ix_support_task_merchant_created', ['merchantId', 'createdAt'])
@Index('ix_support_task_status_severity', ['status', 'severity'])
@Index('uq_support_task_source_event', ['kind', 'sourceEventId'], {
  unique: true,
  where: 'source_event_id is not null',
})
export class SupportTaskEntity extends MerchantScopedEntity {
  @ManyToOne(() => MerchantEntity)
  @Column({ name: 'status', type: 'text', default: 'open' })
  status!: SupportTaskStatus;

  @Column({ name: 'title', type: 'text' })
  title!: string;

  /** Free text, and it is what the support agent actually reads. Keep the facts in it. */
  @Column({ name: 'body', type: 'text' })
  body!: string;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ name: 'resolution_note', type: 'text', nullable: true })
  resolutionNote!: string | null;

}
