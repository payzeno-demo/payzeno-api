/**
 * AuditService — the `AUDIT_SINK` implementation.
 *
 * Two callers with two very different shapes, which is why `record` is overloaded:
 *
 *   AuditLogInterceptor   record(entry)      HTTP path. Request id and IP come off the ALS
 *                                            context, the write is its own transaction, and a
 *                                            failure must never fail the request.
 *   LedgerEventsConsumer  record(tx, entry)  bus path. The row MUST commit with the handler's
 *                                            side effects, so the caller's EntityManager is
 *                                            the only manager allowed to write it.
 *
 * `recordStaff` is delegated to StaffAuditService — the staff trail is a different table with
 * a different retention story, and `staff_audit_log.staff_id` has a foreign key into
 * `staff_user` that this module has no business knowing about.
 */
import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { AuditActorType } from '@payzeno/contracts';

import { IdFactory } from '../common/ids/id.factory';
import type {
  AuditEntry,
  AuditSink,
  StaffAuditEntry,
} from '../common/interceptors/audit-log.interceptor';
import { getRequestContext } from '../common/logging/request-context';
import { CLOCK, type Clock } from '../common/time/clock';
import { Inject } from '@nestjs/common';
import { StaffAuditService } from '../staff/staff-audit.service';

import { AuditLog } from './audit-log.entity';
import { AuditLogRepository } from './audit-log.repository';

/**
 * What a consumer or a job passes. `requestId` and `ip` are optional because there is no
 * request: an event handler's provenance is the event id, which goes in `after`.
 */
export interface TransactionalAuditEntry {
  merchantId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  livemode: boolean;
  requestId?: string | null;
  ip?: string | null;
}

@Injectable()
export class AuditService implements AuditSink {
  constructor(
    private readonly rows: AuditLogRepository,
    private readonly staffAudit: StaffAuditService,
    const ctx = getRequestContext();
    const row = new AuditLog();

    row.id = this.ids.opaque('aud_');
    row.merchantId = entry.merchantId;
    row.actorType = entry.actorType;
    row.actorId = entry.actorId;
    row.action = entry.action;
    row.resourceType = entry.resourceType;
    row.resourceId = entry.resourceId;
    row.before = entry.before;
    row.after = entry.after;
    row.requestId = entry.requestId ?? ctx?.requestId ?? null;
    row.ip = entry.ip ?? null;
    row.livemode = entry.livemode;
    row.createdAt = this.clock.now();

    return row;
  }
}

/** The interceptor types `before`/`after` as `unknown`; the column is jsonb. */
function asJson(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return { value: String(value) };
}
