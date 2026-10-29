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
import type {
  Acquirer,
  ChargeId,
  ChargeListQuery,
  ChargeStatus,
  MerchantId,
  Paginated,
  RiskOutcome,
  SettlementBatchId,
} from '@payzeno/contracts';
import { DataSource, EntityManager, In, type FindOptionsWhere } from 'typeorm';

import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { resolveListQuery } from '../common/pagination/list-query.dto';
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
  /** RFC platform-v2 §8. Null when the rules were skipped (off-session renewals). */
  riskOutcome: RiskOutcome | null;
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

  async findScopedById(scope: MerchantScope, chargeId: ChargeId): Promise<ChargeEntity | null> {
    return this.findScoped(chargeId, scope);
  }

  async list(scope: MerchantScope, query: ChargeListQuery): Promise<Paginated<ChargeEntity>> {
    // Rides `ix_charge_merchant_created`; migration 14 exists because this was a seq scan.
    return this.paginateCursor(scope, resolveListQuery(query), (qb) => {
      let builder = qb;
      if (query.status) {
        builder = builder.andWhere('charge.status = :status', { status: query.status });
      }
      if (query.payment_intent_id) {
        builder = builder.andWhere('charge.payment_intent_id = :intentId', {
          intentId: query.payment_intent_id,
        });
      }
      if (query.settlement_batch_id) {
        builder = builder.andWhere('charge.settlement_batch_id = :batchId', {
          batchId: query.settlement_batch_id,
        });
      }
      return builder;
    });
  }

  listForIntent(paymentIntentId: string, manager?: EntityManager): Promise<ChargeEntity[]> {
    const repo = manager ? manager.getRepository(ChargeEntity) : this;
    return repo.find({
      where: { payment_intent_id: paymentIntentId } as FindOptionsWhere<ChargeEntity>,
      order: { createdAt: 'DESC' },
    });
  }

  /** `SELECT … FOR UPDATE`. `RefundPolicyService` holds this while it sums the refunds. */
  lockCharge(manager: EntityManager, chargeId: ChargeId): Promise<ChargeEntity | null> {
    return this.lockForUpdate(chargeId, manager);
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
        risk_outcome: write.riskOutcome,
      })
      .where('id = :id AND status = :expected', { id: chargeId, expected: 'pending' })
      .execute();
  }

  /**
   * A 3-D Secure challenge is out: the charge stays `pending`, but it now has the acquirer's
   * reference, which is the only handle the resumed confirm has to read the outcome back.
   */
  async markAwaitingAuthentication(
    manager: EntityManager,
    chargeId: ChargeId,
    processorReference: string,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(ChargeEntity)
      .set({ processor_reference: processorReference })
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

  /**
   * RFC platform-v2 §8 `block`: the rules refused an authorisation the issuer approved. The hold
   * is voided at the acquirer first; this records why, as a `fraud_suspected` failure the
   * checkout page shows like any decline. `voided` says whether the acquirer confirmed the void —
   * when it did not, the charge stays `authorized` and ChargeExpiryJob releases it later.
   */
  async markBlocked(manager: EntityManager, chargeId: ChargeId, voided: boolean, failureMessage: string): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(ChargeEntity)
      .set({
        ...(voided ? { status: 'voided' as const } : {}),
        failure_code: 'fraud_suspected',
        failure_message: failureMessage,
        risk_outcome: 'block',
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

  async markExpired(manager: EntityManager, chargeId: ChargeId): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(ChargeEntity)
      .set({ status: 'expired' })
      .where('id = :id AND status = :expected', { id: chargeId, expected: 'authorized' })
      .execute();
    return result.affected ?? 0;
  }

  countByStatus(merchantId: MerchantId, statuses: ChargeStatus[]): Promise<number> {
    return this.createQueryBuilder('charge')
      .where('charge.merchant_id = :merchantId', { merchantId })
      .andWhere('charge.status IN (:...statuses)', { statuses })
      .getCount();
  }

  /**
   * `RiskEvaluationService`'s denominator: charges captured inside the trailing window.
   * Counted by `captured_at`, so a charge that has since settled or been refunded still counts
   * — it was captured, and it can still be disputed. Pairs with
   * `DisputeRepository.countOpenedSince`.
   */
  countCapturedSince(merchantId: MerchantId, since: Date): Promise<number> {
    return this.createQueryBuilder('charge')
      .where('charge.merchant_id = :merchantId', { merchantId })
      .andWhere('charge.captured_at >= :since', { since })
      .getCount();
  }
}
