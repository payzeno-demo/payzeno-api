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
    const task = this.build(input);

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
