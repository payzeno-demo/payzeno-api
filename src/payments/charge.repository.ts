/**
 * L1. The only code in the repo that writes `charge`.
 *
 * Frame 6 of the persistence chain: ChargeCaptureService → TransactionManager.runInTransaction
 * → **ChargeRepository.markCaptured** → PayzenoRepository.updateScoped → QueryBuilder.update.
 *
 * Everything here takes an optional `EntityManager` so it can run inside the caller's
 * transaction. A repository that opens its own transaction is a repository that breaks the
 * outbox invariant (`OutboxEventPublisher` writes `event_outbox` in the SAME transaction as
 * the business row — ADR 0011).
 */

import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In, type FindOptionsWhere } from 'typeorm';
import type {
  Acquirer,
  ChargeId,
  ChargeListQuery,
  ChargeStatus,
  MerchantId,
  Paginated,
  SettlementBatchId,
} from '@payzeno/contracts';

import { PayzenoRepository } from '../common/persistence/payzeno.repository';
import { ChargeEntity } from './charge.entity';

export interface CaptureWrite {
  capturedAmountMinor: number;
  processorReference: string;
  capturedAt: Date;
}

export interface AuthorizationWrite {
  networkTransactionId: string | null;
  authorizationCode: string | null;
  processorReference: string;
  authorizedAt: Date;
  authorizationExpiresAt: Date;
  riskScore: number;
}

@Injectable()
export class ChargeRepository extends PayzenoRepository<ChargeEntity> {
  constructor(dataSource: DataSource) {
    super(ChargeEntity, dataSource.createEntityManager());
  }

  findByProcessorReference(acquirer: Acquirer, processorReference: string): Promise<ChargeEntity | null> {
    return this.findOne({
      where: { acquirer, processor_reference: processorReference } as FindOptionsWhere<ChargeEntity>,
    });
  }

  async list(merchantId: MerchantId, query: ChargeListQuery): Promise<Paginated<ChargeEntity>> {
    const where: FindOptionsWhere<ChargeEntity> = { merchant_id: merchantId } as FindOptionsWhere<ChargeEntity>;
    if (query.status) {
      (where as Record<string, unknown>).status = query.status;
    }
    if (query.payment_intent_id) {
      (where as Record<string, unknown>).payment_intent_id = query.payment_intent_id;
    }
    if (query.settlement_batch_id) {
      (where as Record<string, unknown>).settlement_batch_id = query.settlement_batch_id;
    }
    // Rides `ix_charge_merchant_created`; migration 14 exists because this was a seq scan.
    return this.paginateCursor(query, where, { column: 'created_at', direction: 'DESC' });
  }

  listForIntent(paymentIntentId: string, manager?: EntityManager): Promise<ChargeEntity[]> {
    const repo = manager ? manager.getRepository(ChargeEntity) : this;
    return repo.find({
      where: { payment_intent_id: paymentIntentId } as FindOptionsWhere<ChargeEntity>,
      order: { created_at: 'DESC' },
    });
  }

  async addRefundedAmount(manager: EntityManager, chargeId: ChargeId, amountMinor: number): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(ChargeEntity)
      .set({ refunded_amount_minor: () => `refunded_amount_minor + ${Math.trunc(amountMinor)}` })
      .where('id = :id', { id: chargeId })
      .execute();
  }

  /**
   * Rides `pix_charge_unsettled`. `UnsettledChargeSweepJob` (PAY-2058) reads it: a
   * `settlement.completed` chunk lost to the DLQ strands charges `captured` forever, and until
   * that job existed the partial index had no reader at all.
   */
  /** Rides `ix_charge_authorization_expires`. `ChargeExpiryJob` drives `authorized → expired`. */
  findExpiredAuthorizations(now: Date, limit: number): Promise<ChargeEntity[]> {
    return this.createQueryBuilder('charge')
      .where('charge.status = :status', { status: 'authorized' })
      .andWhere('charge.authorization_expires_at < :now', { now })
      .orderBy('charge.authorization_expires_at', 'ASC')
      .limit(limit)
      .getMany();
  }

}
