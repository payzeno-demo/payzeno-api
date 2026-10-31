/**
 * Persistence for `audit_log`. Reads ride `ix_audit_log_merchant_created` and
 * `ix_audit_log_resource`; there is deliberately no update and no delete.
 */
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import type { MerchantId } from '@payzeno/contracts';

import { PayzenoRepository, toInsertRow, toInsertRows } from '../common/persistence/payzeno.repository';

import { AuditLog } from './audit-log.entity';

export interface AuditLogQuery {
  merchantId: MerchantId;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  limit: number;
}

@Injectable()
export class AuditLogRepository extends PayzenoRepository<AuditLog> {
  constructor(dataSource: DataSource) {
    super(AuditLog, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'audit_log';
  }

  /**
   * The write. `manager` is the caller's transaction when there is one — an audit row that
   * commits while the change it describes rolls back is worse than no audit row.
   */
  async append(row: AuditLog, manager?: EntityManager): Promise<AuditLog> {
    const repo = manager ? manager.getRepository(AuditLog) : this;
    await repo.insert(toInsertRow(row));
    return row;
  }

  /** Bulk append for the consumers, which batch several rows per bus event. */
  async appendMany(rows: readonly AuditLog[], manager?: EntityManager): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }
    const repo = manager ? manager.getRepository(AuditLog) : this;
    await repo.insert(toInsertRows(rows));
    return rows.length;
  }

  /** Console activity feed. `ix_audit_log_merchant_created`, newest first. */
  async listForMerchant(query: AuditLogQuery): Promise<AuditLog[]> {
    let qb = this.createQueryBuilder('audit_log')
      .where('audit_log.merchant_id = :merchantId', { merchantId: query.merchantId })
      .orderBy('audit_log.created_at', 'DESC')
      .limit(query.limit);

    if (query.action) {
      qb = qb.andWhere('audit_log.action = :action', { action: query.action });
    }
    if (query.resourceType) {
      qb = qb.andWhere('audit_log.resource_type = :resourceType', {
        resourceType: query.resourceType,
      });
    }
    if (query.resourceId) {
      qb = qb.andWhere('audit_log.resource_id = :resourceId', { resourceId: query.resourceId });
    }

    return qb.getMany();
  }

  /**
   * Everything that ever happened to one resource, oldest first. This is the query a support
   * agent runs during a duplicate-settlement remediation, so it must not be tenant-scoped:
   * the interesting rows are the ones written by `internal_service` with a null merchant.
   */
  async timelineFor(resourceType: string, resourceId: string): Promise<AuditLog[]> {
    return this.createQueryBuilder('audit_log')
      .where('audit_log.resource_type = :resourceType', { resourceType })
      .andWhere('audit_log.resource_id = :resourceId', { resourceId })
      .orderBy('audit_log.created_at', 'ASC')
      .getMany();
  }

  /** Used by the reporting summary to count merchant-visible mutations in a window. */
  async countSince(merchantId: MerchantId, since: Date): Promise<number> {
    return this.createQueryBuilder('audit_log')
      .where('audit_log.merchant_id = :merchantId', { merchantId })
      .andWhere('audit_log.created_at >= :since', { since })
      .getCount();
  }
}
