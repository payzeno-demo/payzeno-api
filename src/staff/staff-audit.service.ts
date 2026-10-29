/**
 * StaffAuditService — the writer of `staff_audit_log`.
 *
 * Every `@StaffOnly()` handler produces a row here, routed by AuditLogInterceptor on the
 * principal rather than on the route: a staff user editing a merchant through the ordinary
 * merchant route must still land in the staff trail, or "who suspended this merchant" has two
 * possible answers and the monthly review has to reconcile them by hand.
 *
 * The table is append-only and nothing prunes it. data-model.md §1.14.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository, type EntityManager } from 'typeorm';

import { IdFactory } from '../common/ids/id.factory';
import type { StaffAuditEntry } from '../common/interceptors/audit-log.interceptor';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { getRequestContext } from '../common/logging/request-context';
import { toInsertRow } from '../common/persistence/payzeno.repository';
import { CLOCK, type Clock } from '../common/time/clock';

import { StaffAuditLog } from './staff-user.entity';

/** Actions the monthly review always reads, whatever else was filtered out. */
export const REVIEWED_STAFF_ACTIONS: readonly string[] = [
  'merchant.status.change',
  'dispute.accept',
  'settlement.item.retry',
  'payout.create',
  'vault.tokenise',
];

@Injectable()
export class StaffAuditService {
  constructor(
    @InjectRepository(StaffAuditLog) private readonly rows: Repository<StaffAuditLog>,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /** The interceptor's entry point, via AuditService.recordStaff. */
  async record(entry: StaffAuditEntry, manager?: EntityManager): Promise<StaffAuditLog> {
    const row = this.toRow(entry);
    const repo = manager ? manager.getRepository(StaffAuditLog) : this.rows;

    await repo.insert(toInsertRow(row));

    if (REVIEWED_STAFF_ACTIONS.includes(row.action)) {
      // These are the ones risk reads every month; surfacing them in the access log too
      // means the reviewer can cross-check the trail against something they did not write.
      this.logger.info('staff.reviewed_action', {
        staff_id: row.staffId,
        action: row.action,
        acting_merchant_id: row.actingMerchantId,
        resource_id: row.resourceId,
        has_reason: row.reason !== null,
      });
    }

    return row;
  }

  /** One operator's history, newest first. `ix_staff_audit_log_staff_created`. */
  async listForStaff(staffId: string, limit = 100): Promise<StaffAuditLog[]> {
    return this.rows.find({
      where: { staffId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Everything platform operators did to one merchant. This is what a merchant's account
   * manager reads before answering "why was my account restricted".
   */
  async listForMerchant(merchantId: string, limit = 100): Promise<StaffAuditLog[]> {
    return this.rows.find({
      where: { actingMerchantId: merchantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * The monthly review extract. Rows whose action is on the reviewed list and whose reason
   * is blank are the ones that get bounced back to the operator.
   */
  async reviewWindow(from: Date, to: Date): Promise<{ rows: StaffAuditLog[]; unexplained: number }> {
    const rows = await this.rows.find({
      where: { createdAt: Between(from, to) },
      order: { createdAt: 'ASC' },
      take: 5000,
    });

    const reviewed = rows.filter((row) => REVIEWED_STAFF_ACTIONS.includes(row.action));
    const unexplained = reviewed.filter((row) => !row.reason || row.reason.trim() === '').length;

    return { rows: reviewed, unexplained };
  }

  private toRow(entry: StaffAuditEntry): StaffAuditLog {
    const ctx = getRequestContext();
    const row = new StaffAuditLog();

    row.id = this.ids.opaque('sal_');
    row.staffId = entry.staffId;
    row.actingMerchantId = entry.actingMerchantId;
    row.action = entry.action;
    row.resourceType = entry.resourceType;
    row.resourceId = entry.resourceId;
    row.before = toJson(entry.before);
    row.after = toJson(entry.after);
    row.reason = entry.reason;
    row.requestId = entry.requestId ?? ctx?.requestId ?? null;
    row.ip = entry.ip;
    row.createdAt = this.clock.now();

    return row;
  }
}

function toJson(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === 'object' ? (value as Record<string, unknown>) : { value: String(value) };
}
