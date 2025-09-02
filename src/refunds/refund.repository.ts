/**
 * L1. The only writer of `refund`.
 *
 * Every method takes an optional `EntityManager` so it can join the caller's transaction:
 * `RefundsService.create` writes the refund row, bumps `charge.refunded_amount_minor` and
 * enqueues `refund.created` on the outbox in ONE transaction, and a repository that opened its
 * own connection would break that (ADR 0011).
 */

import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import type { ChargeId, Paginated, RefundId, RefundStatus } from '@payzeno/contracts';

import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import type { ResolvedListQuery } from '../common/pagination/list-query.dto';
import { PayzenoRepository } from '../common/persistence/payzeno.repository';
import { RefundEntity } from './refund.entity';

export interface NewRefundRow {
  id: RefundId;
  merchantId: string;
  chargeId: ChargeId;
  amountMinor: number;
  currency: string;
  reason: RefundEntity['reason'];
  metadata: Record<string, string>;
  livemode: boolean;
  createdAt: Date;
}

@Injectable()
export class RefundRepository extends PayzenoRepository<RefundEntity> {
  constructor(dataSource: DataSource) {
    super(RefundEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'refund';
  }

  listForCharge(
    scope: MerchantScope,
    query: ResolvedListQuery,
    chargeId?: ChargeId,
  ): Promise<Paginated<RefundEntity>> {
    return this.paginateCursor(scope, query, (qb) =>
      chargeId ? qb.andWhere('refund.charge_id = :chargeId', { chargeId }) : qb,
    );
  }

  /**
   * The number `RefundPolicyService` compares against `charge.captured_amount_minor`. Read
   * inside the transaction that holds the charge's row lock — outside it, two concurrent
   * refunds each see the other's absence and both pass the check.
   *
   * `canceled` and `failed` refunds do not count: the money came back.
   */
  async sumRefundedForCharge(manager: EntityManager, chargeId: ChargeId): Promise<number> {
    const row = await manager
      .createQueryBuilder(RefundEntity, 'refund')
      .select('coalesce(sum(refund.amount_minor), 0)', 'total')
      .where('refund.charge_id = :chargeId', { chargeId })
      .andWhere("refund.status in ('pending','succeeded')")
      .getRawOne<{ total: string }>();

    return Number(row?.total ?? 0);
  }

  async insertRefund(manager: EntityManager, row: NewRefundRow): Promise<RefundEntity> {
    const entity = manager.create(RefundEntity, {
      id: row.id,
      merchantId: row.merchantId,
      charge_id: row.chargeId,
      amount_minor: row.amountMinor,
      currency: row.currency as RefundEntity['currency'],
      status: 'pending' as RefundStatus,
      reason: row.reason,
      failure_reason: null,
      processor_reference: null,
      metadata: row.metadata,
      livemode: row.livemode,
      succeeded_at: null,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    });

    return manager.save(RefundEntity, entity);
  }

  async markSucceeded(
    manager: EntityManager,
    refundId: RefundId,
    processorReference: string,
    succeededAt: Date,
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(RefundEntity)
      .set({ status: 'succeeded', processor_reference: processorReference, succeeded_at: succeededAt })
      .where('id = :id AND status = :expected', { id: refundId, expected: 'pending' })
      .execute();
    return result.affected ?? 0;
  }

  async markFailed(manager: EntityManager, refundId: RefundId, failureReason: string): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(RefundEntity)
      .set({ status: 'failed', failure_reason: failureReason })
      .where('id = :id AND status = :expected', { id: refundId, expected: 'pending' })
      .execute();
    return result.affected ?? 0;
  }

  async markCanceled(manager: EntityManager, refundId: RefundId): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(RefundEntity)
      .set({ status: 'canceled' })
      .where('id = :id AND status = :expected', { id: refundId, expected: 'pending' })
      .execute();
    return result.affected ?? 0;
  }

  /** How `ProcessorWebhookService` resolves an inbound `refund_settled` back to our row. */
  findByProcessorReference(processorReference: string): Promise<RefundEntity | null> {
    return this.findOne({ where: { processor_reference: processorReference } });
  }

  /** Reporting + the console's charge detail panel. Not paginated: a charge has a handful. */
  findAllForCharge(chargeId: ChargeId): Promise<RefundEntity[]> {
    return this.find({ where: { charge_id: chargeId }, order: { createdAt: 'DESC' } });
  }

  countByStatus(merchantId: string, status: RefundStatus): Promise<number> {
    return this.count({ where: { merchantId, status } });
  }
}
