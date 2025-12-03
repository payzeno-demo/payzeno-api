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
  /** Trailing-window dispute count — `DisputeRateCalculator` divides by charge volume. */
  countOpenedSince(merchantId: string, since: Date): Promise<number> {
    return this.createQueryBuilder('dispute')
      .where('dispute.merchant_id = :merchantId', { merchantId })
      .andWhere('dispute.created_at >= :since', { since })
      .getCount();
  }
}
