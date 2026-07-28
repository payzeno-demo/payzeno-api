/**
 * SupportTasksService — arc INC's sink.
 *
 * Two callers, and they matter for different reasons:
 *
 *   LedgerEventsConsumer   `settlement.duplicate_detected` on a `capture_at_settlement`
 *                          merchant, and `ledger.imbalance_detected`. Both pass the consumer's
 *                          EntityManager, so the task is written in the SAME transaction as
 *                          the `processed_event` claim. If the handler rolls back, the task
 *                          vanishes with it and the redelivery writes it again — exactly once
 *                          in effect, which is the property the incident needed and did not
 *                          have on 2026-04-28.
 *   InternalController     `POST /internal/v1/support-tasks`, called by payzeno-ledger's own
 *                          duplicate branch and by payzeno-billing-legacy's DunningService.
 *                          No ambient transaction there, so `open()` takes the manager as an
 *                          argument rather than reaching for one.
 *
 * `openIdempotent` is the one to use from anywhere fed by the bus: `uq_support_task_source_event`
 * turns a redelivered event into a no-op instead of a duplicate row.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import type { ChargeId, MerchantId } from '@payzeno/contracts';

import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';

import {
  SupportTaskEntity,
  type SupportTaskKind,
  type SupportTaskSeverity,
} from './support-task.entity';

export interface OpenSupportTaskInput {
  kind: SupportTaskKind;
  merchantId: MerchantId;
  chargeId: ChargeId | null;
  severity: SupportTaskSeverity;
  title: string;
  body: string;
  sourceEventId: string | null;
  livemode?: boolean;
}

@Injectable()
export class SupportTasksService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * Opens a task inside the caller's transaction. Returns the id.
   *
   * `ON CONFLICT DO NOTHING` on `uq_support_task_source_event`, so a redelivered event is a
   * no-op rather than a second row. The `RETURNING` tells us which happened.
   */
  async open(manager: EntityManager, input: OpenSupportTaskInput): Promise<string> {
    const task = this.build(input);

    const inserted = (await manager
      .createQueryBuilder()
      .insert()
      .into(SupportTaskEntity)
      .values(task)
      .orIgnore()
      .returning('id')
      .execute()) as { raw: Array<{ id: string }> };

    const created = inserted.raw.length > 0;

    this.logger.info(created ? 'support_task.opened' : 'support_task.duplicate_suppressed', {
      support_task_id: task.id,
      kind: task.kind,
      severity: task.severity,
      merchant_id: task.merchantId,
      charge_id: task.chargeId,
      source_event_id: task.sourceEventId,
    });

    return created ? task.id : (await this.findBySourceEvent(input)) ?? task.id;
  }

  /** For callers with no ambient transaction — the internal route, and the dunning webhook. */
  async openStandalone(input: OpenSupportTaskInput): Promise<string> {
    return this.dataSource.transaction((manager) => this.open(manager, input));
  }

  async listOpenForMerchant(merchantId: MerchantId, limit = 50): Promise<SupportTaskEntity[]> {
    return this.dataSource
      .getRepository(SupportTaskEntity)
      .createQueryBuilder('support_task')
      .where('support_task.merchant_id = :merchantId', { merchantId })
      .andWhere("support_task.status in ('open', 'acknowledged')")
      .orderBy('support_task.created_at', 'DESC')
      .take(limit)
      .getMany();
  }

  /** The remediation queue the incident channel worked off. Severity first, then age. */
  async listOpenByKind(kind: SupportTaskKind, limit = 200): Promise<SupportTaskEntity[]> {
    return this.dataSource
      .getRepository(SupportTaskEntity)
      .createQueryBuilder('support_task')
      .where('support_task.kind = :kind', { kind })
      .andWhere("support_task.status in ('open', 'acknowledged')")
      .orderBy(
        `case support_task.severity
           when 'critical' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
        'ASC',
      )
      .addOrderBy('support_task.created_at', 'ASC')
      .take(limit)
      .getMany();
  }

  async resolve(taskId: string, note: string, resolvedBy: string): Promise<void> {
    const affected = await this.dataSource
      .getRepository(SupportTaskEntity)
      .createQueryBuilder()
      .update()
      .set({ status: 'resolved', resolvedAt: this.clock.now(), resolutionNote: note, assignedTo: resolvedBy })
      .where('id = :taskId', { taskId })
      .andWhere("status in ('open', 'acknowledged')")
      .execute();

    this.logger.info('support_task.resolved', {
      support_task_id: taskId,
      resolved_by: resolvedBy,
      affected: affected.affected ?? 0,
    });
  }

  private build(input: OpenSupportTaskInput): SupportTaskEntity {
    const task = new SupportTaskEntity();
    const now = this.clock.now();

    task.id = this.ids.opaque('sup_');
    task.merchantId = input.merchantId;
    task.livemode = input.livemode ?? true;
    task.kind = input.kind;
    task.severity = input.severity;
    task.status = 'open';
    task.chargeId = input.chargeId;
    task.title = input.title;
    task.body = input.body;
    task.sourceEventId = input.sourceEventId;
    task.assignedTo = null;
    task.resolvedAt = null;
    task.resolutionNote = null;
    task.createdAt = now;
    task.updatedAt = now;

    return task;
  }

  private async findBySourceEvent(input: OpenSupportTaskInput): Promise<string | null> {
    if (!input.sourceEventId) return null;

    const existing = await this.dataSource.getRepository(SupportTaskEntity).findOne({
      where: { kind: input.kind, sourceEventId: input.sourceEventId },
    });

    return existing?.id ?? null;
  }
}
