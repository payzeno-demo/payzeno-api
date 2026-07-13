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

  protected get alias(): string {
    return 'charge';
  }

  /**
   * `uq_charge_processor_reference` (migration 16, dhotfix, committed during PAY-2041) makes
   * this an index lookup. It is how an inbound acquirer webhook — which knows a processor
   * reference and nothing else — finds the charge it is about.
   */
  findByProcessorReference(acquirer: Acquirer, processorReference: string): Promise<ChargeEntity | null> {
    return this.findOne({
      where: { acquirer, processor_reference: processorReference } as FindOptionsWhere<ChargeEntity>,
    });
  }

  async findScopedById(merchantId: MerchantId, chargeId: ChargeId): Promise<ChargeEntity | null> {
    return this.findOneScoped(merchantId, chargeId);
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

  /** `SELECT … FOR UPDATE`. `RefundPolicyService` holds this while it sums the refunds. */
  lockCharge(manager: EntityManager, chargeId: ChargeId): Promise<ChargeEntity | null> {
    return this.lockForUpdate(manager, chargeId);
  }

  async markAuthorized(manager: EntityManager, chargeId: ChargeId, write: AuthorizationWrite): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(ChargeEntity)
      .set({
        status: 'authorized',
        network_transaction_id: write.networkTransactionId,
        authorization_code: write.authorizationCode,
        processor_reference: write.processorReference,
        authorized_at: write.authorizedAt,
        authorization_expires_at: write.authorizationExpiresAt,
        risk_score: write.riskScore,
      })
      .where('id = :id AND status = :expected', { id: chargeId, expected: 'pending' })
      .execute();
  }

  async markDeclined(
    manager: EntityManager,
    chargeId: ChargeId,
    failureCode: string,
    failureMessage: string,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(ChargeEntity)
      .set({ status: 'failed', failure_code: failureCode as never, failure_message: failureMessage })
      .where('id = :id', { id: chargeId })
      .execute();
  }

  /**
   * The capture write. Guarded on `status = 'authorized'` in the WHERE clause, not only by the
   * FSM: two concurrent captures with the same idempotency key are rejected by the
   * interceptor, but two captures with *different* keys are not, and the `affected` count is
   * what tells `ChargeCaptureService` it lost that race.
   */
  async markCaptured(manager: EntityManager, chargeId: ChargeId, write: CaptureWrite): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(ChargeEntity)
      .set({
        status: 'captured',
        captured_amount_minor: write.capturedAmountMinor,
        processor_reference: write.processorReference,
        captured_at: write.capturedAt,
      })
      .where('id = :id AND status = :expected', { id: chargeId, expected: 'authorized' })
      .execute();
    return result.affected ?? 0;
  }

  async markVoided(manager: EntityManager, chargeId: ChargeId): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(ChargeEntity)
      .set({ status: 'voided' })
      .where('id = :id AND status = :expected', { id: chargeId, expected: 'authorized' })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Driven only by `settlement.completed` (LedgerEventsConsumer) and by
   * `POST /internal/v1/charges/:chargeId/settled` when a single orphan is resolved out of band.
   */
  async markSettled(
    manager: EntityManager,
    chargeIds: ChargeId[],
    batchId: SettlementBatchId,
    settledAt: Date,
  ): Promise<number> {
    if (chargeIds.length === 0) {
      return 0;
    }
    const result = await manager
      .createQueryBuilder()
      .update(ChargeEntity)
      .set({ status: 'settled', settlement_batch_id: batchId, settled_at: settledAt })
      .where({ id: In(chargeIds), status: 'captured' })
      .execute();
    return result.affected ?? 0;
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
  findStrandedCaptures(olderThan: Date, limit: number): Promise<ChargeEntity[]> {
    return this.createQueryBuilder('charge')
      .where('charge.settlement_batch_id IS NULL')
      .andWhere('charge.status = :status', { status: 'captured' })
      .andWhere('charge.captured_at < :cutoff', { cutoff: olderThan })
      .orderBy('charge.captured_at', 'ASC')
      .limit(limit)
      .getMany();
  }

  /** Rides `ix_charge_authorization_expires`. `ChargeExpiryJob` drives `authorized → expired`. */
  findExpiredAuthorizations(now: Date, limit: number): Promise<ChargeEntity[]> {
    return this.createQueryBuilder('charge')
      .where('charge.status = :status', { status: 'authorized' })
      .andWhere('charge.authorization_expires_at < :now', { now })
      .orderBy('charge.authorization_expires_at', 'ASC')
      .limit(limit)
      .getMany();
  }

  countByStatus(merchantId: MerchantId, statuses: ChargeStatus[]): Promise<number> {
    return this.createQueryBuilder('charge')
      .where('charge.merchant_id = :merchantId', { merchantId })
      .andWhere('charge.status IN (:...statuses)', { statuses })
      .getCount();
  }
}
