/**
 * L1. The only writer of `dispute`.
 *
 * `insertDispute` deliberately does NOT do a `SELECT … WHERE status IN ('needs_response',
 * 'under_review')` first. Check-then-act around a side effect is the shape ADR 0011 forbids in
 * the money path — the open-dispute uniqueness lives in `uq_dispute_charge_open` and arrives
 * back here as a 23505, which `DisputesService` turns into DuplicateDisputeException.
 */

import { Injectable } from '@nestjs/common';
import { DataSource, LessThan, type EntityManager } from 'typeorm';
import type {
  ChargeId,
  DisputeEvidence,
  DisputeId,
  DisputeReason,
  DisputeStatus,
  Paginated,
} from '@payzeno/contracts';

import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import type { ResolvedListQuery } from '../common/pagination/list-query.dto';
import { PayzenoRepository } from '../common/persistence/payzeno.repository';
import { DisputeEntity } from './dispute.entity';

export interface NewDisputeRow {
  id: DisputeId;
  merchantId: string;
  chargeId: ChargeId;
  amountMinor: number;
  feeMinor: number;
  currency: string;
  reason: DisputeReason;
  networkReasonCode: string;
  evidenceDueBy: Date | null;
  isChargeRefundable: boolean;
  liabilityShifted: boolean;
  status: DisputeStatus;
  livemode: boolean;
  openedAt: Date;
}

@Injectable()
export class DisputeRepository extends PayzenoRepository<DisputeEntity> {
  constructor(dataSource: DataSource) {
    super(DisputeEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'dispute';
  }

  listScoped(
    scope: MerchantScope,
    query: ResolvedListQuery,
    status?: DisputeStatus,
  ): Promise<Paginated<DisputeEntity>> {
    return this.paginateCursor(scope, query, (qb) =>
      status ? qb.andWhere('dispute.status = :status', { status }) : qb,
    );
  }

  /**
   * Throws through `mapTypeOrmError`, so a 23505 on `uq_dispute_charge_open` arrives at the
   * service as a ConflictException carrying the constraint name.
   */
  async insertDispute(manager: EntityManager, row: NewDisputeRow): Promise<DisputeEntity> {
    const entity = manager.create(DisputeEntity, {
      id: row.id,
      merchantId: row.merchantId,
      charge_id: row.chargeId,
      amount_minor: row.amountMinor,
      fee_minor: row.feeMinor,
      currency: row.currency as DisputeEntity['currency'],
      status: row.status,
      reason: row.reason,
      network_reason_code: row.networkReasonCode,
      evidence_due_by: row.evidenceDueBy,
      evidence: {},
      is_charge_refundable: row.isChargeRefundable,
      liability_shifted: row.liabilityShifted,
      livemode: row.livemode,
      submitted_at: null,
      resolved_at: null,
      createdAt: row.openedAt,
      updatedAt: row.openedAt,
    });

    return manager.save(DisputeEntity, entity);
  }

  findOpenForCharge(chargeId: ChargeId): Promise<DisputeEntity | null> {
    return this.createQueryBuilder('dispute')
      .where('dispute.charge_id = :chargeId', { chargeId })
      .andWhere("dispute.status in ('needs_response','under_review')")
      .getOne();
  }

  /** Evidence is staged and submitted in one write so a crash cannot lose the merchant's text. */
  async saveEvidence(
    manager: EntityManager,
    disputeId: DisputeId,
    evidence: DisputeEvidence,
    submittedAt: Date | null,
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(DisputeEntity)
      .set(submittedAt ? { evidence, submitted_at: submittedAt, status: 'under_review' } : { evidence })
      .where('id = :id AND status = :expected', { id: disputeId, expected: 'needs_response' })
      .execute();
    return result.affected ?? 0;
  }

  async transitionStatus(
    manager: EntityManager,
    disputeId: DisputeId,
    from: DisputeStatus,
    to: DisputeStatus,
    resolvedAt: Date | null = null,
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(DisputeEntity)
      .set(resolvedAt ? { status: to, resolved_at: resolvedAt } : { status: to })
      .where('id = :id AND status = :from', { id: disputeId, from })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Rides `pix_dispute_evidence_due`. `DisputeDeadlineReminderJob` reads it nightly and drives
   * `needs_response → lost` past the deadline; without that job the liability leg never
   * resolves and the merchant's balance stays understated forever (domain-model §5).
   */
  findPastEvidenceDeadline(now: Date, limit: number): Promise<DisputeEntity[]> {
    return this.find({
      where: { status: 'needs_response', evidence_due_by: LessThan(now) },
      order: { evidence_due_by: 'ASC' },
      take: limit,
    });
  }

  /** Trailing-window dispute count — `DisputeRateCalculator` divides by charge volume. */
  countOpenedSince(merchantId: string, since: Date): Promise<number> {
    return this.createQueryBuilder('dispute')
      .where('dispute.merchant_id = :merchantId', { merchantId })
      .andWhere('dispute.created_at >= :since', { since })
      .getCount();
  }
}
