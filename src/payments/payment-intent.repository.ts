/**
 * L1. The only writer of `payment_intent`.
 *
 * `client_secret` never leaves this file in a WHERE clause built by string concatenation, and
 * `findByClientSecret` is the only lookup that does not carry a merchant id — `ClientSecretGuard`
 * is what turns the secret into a scoped principal, so the scope check happens above.
 */

import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, type FindOptionsWhere } from 'typeorm';
import type {
  CancellationReason,
  ChargeId,
  MerchantId,
  Paginated,
  PaymentIntentId,
  PaymentIntentListQuery,
  PaymentIntentStatus,
} from '@payzeno/contracts';

import { PayzenoRepository } from '../common/persistence/payzeno.repository';
import { PaymentIntentEntity } from './payment-intent.entity';

@Injectable()
export class PaymentIntentRepository extends PayzenoRepository<PaymentIntentEntity> {
  constructor(dataSource: DataSource) {
    super(PaymentIntentEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'payment_intent';
  }

  /**
   * The only INSERT into `payment_intent`. Takes the manager so `PaymentIntentsService.create`
   * can write the row and (when `confirm=true`) run the confirm flow's first transition
   * without a window in which the intent exists but is unconfirmable.
   */
  async insertIntent(
    manager: EntityManager,
    row: Partial<PaymentIntentEntity> & { id: PaymentIntentId },
  ): Promise<PaymentIntentEntity> {
    const entity = manager.create(PaymentIntentEntity, row);
    return manager.save(PaymentIntentEntity, entity);
  }

  findScopedById(merchantId: MerchantId, id: PaymentIntentId): Promise<PaymentIntentEntity | null> {
    return this.findOneScoped(merchantId, id);
  }

  list(merchantId: MerchantId, query: PaymentIntentListQuery): Promise<Paginated<PaymentIntentEntity>> {
    const where: FindOptionsWhere<PaymentIntentEntity> = {
      merchant_id: merchantId,
    } as FindOptionsWhere<PaymentIntentEntity>;
    if (query.status) {
      (where as Record<string, unknown>).status = query.status;
    }
    if (query.customer_reference) {
      (where as Record<string, unknown>).customer_reference = query.customer_reference;
    }
    return this.paginateCursor(query, where, { column: 'created_at', direction: 'DESC' });
  }

  /** Used by `ClientSecretGuard` only. The secret is the credential; there is no merchant scope yet. */
  findByClientSecret(clientSecret: string): Promise<PaymentIntentEntity | null> {
    return this.findOne({ where: { client_secret: clientSecret } as FindOptionsWhere<PaymentIntentEntity> });
  }

  /** `SELECT … FOR UPDATE` on the intent. Every flow takes this before it touches state. */
  lockIntent(manager: EntityManager, id: PaymentIntentId): Promise<PaymentIntentEntity | null> {
    return this.lockForUpdate(manager, id);
  }

  /**
   * Conditional status write. The expected-status predicate is in the WHERE clause as well as
   * in `PaymentIntentStateMachine.apply`, so a lost update is visible as `affected === 0`
   * rather than as a silently wrong row.
   */
  async transitionStatus(
    manager: EntityManager,
    id: PaymentIntentId,
    from: PaymentIntentStatus,
    to: PaymentIntentStatus,
    patch: Partial<{
      latest_charge_id: ChargeId | null;
      next_action: PaymentIntentEntity['next_action'];
      canceled_at: Date | null;
      cancellation_reason: CancellationReason | null;
    }> = {},
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(PaymentIntentEntity)
      .set({ status: to, ...patch })
      .where('id = :id AND status = :from', { id, from })
      .execute();
    return result.affected ?? 0;
  }

  async setLatestCharge(manager: EntityManager, id: PaymentIntentId, chargeId: ChargeId): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(PaymentIntentEntity)
      .set({ latest_charge_id: chargeId })
      .where('id = :id', { id })
      .execute();
  }

  /** Terminal intents accept a metadata patch and nothing else (domain-model §2). */
  async patchMetadata(
    merchantId: MerchantId,
    id: PaymentIntentId,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.updateScoped(merchantId, id, { metadata } as never);
  }

  countByStatus(merchantId: MerchantId, status: PaymentIntentStatus): Promise<number> {
    return this.count({
      where: { merchant_id: merchantId, status } as FindOptionsWhere<PaymentIntentEntity>,
    });
  }
}
