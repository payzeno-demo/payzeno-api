/**
 * L1. The only writer of `payment_intent`.
 *
 * `client_secret` never leaves this file in a WHERE clause built by string concatenation, and
 * `findByClientSecret` is the only lookup that does not carry a merchant id — `ClientSecretGuard`
 * is what turns the secret into a scoped principal, so the scope check happens above.
 */

import { Injectable } from '@nestjs/common';
import type {
  CancellationReason,
  ChargeId,
  CurrencyCode,
  MerchantId,
  Paginated,
  PaymentIntentId,
  PaymentIntentListQuery,
  PaymentIntentStatus,
  PaymentMethodId,
  Presentment,
  ReviewId,
  SubscriptionId,
} from '@payzeno/contracts';
import { DataSource, EntityManager, type FindOptionsWhere } from 'typeorm';

import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { resolveListQuery } from '../common/pagination/list-query.dto';
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

  findScopedById(scope: MerchantScope, id: PaymentIntentId): Promise<PaymentIntentEntity | null> {
    return this.findScoped(id, scope);
  }

  list(scope: MerchantScope, query: PaymentIntentListQuery): Promise<Paginated<PaymentIntentEntity>> {
    return this.paginateCursor(scope, resolveListQuery(query), (qb) => {
      let builder = qb;
      if (query.status) {
        builder = builder.andWhere('payment_intent.status = :status', { status: query.status });
      }
      if (query.customer_reference) {
        builder = builder.andWhere('payment_intent.customer_reference = :customerReference', {
          customerReference: query.customer_reference,
        });
      }
      return builder;
    });
  }

  /** Used by `ClientSecretGuard` only. The secret is the credential; there is no merchant scope yet. */
  findByClientSecret(clientSecret: string): Promise<PaymentIntentEntity | null> {
    return this.findOne({ where: { client_secret: clientSecret } as FindOptionsWhere<PaymentIntentEntity> });
  }

  /** `SELECT … FOR UPDATE` on the intent. Every flow takes this before it touches state. */
  lockIntent(manager: EntityManager, id: PaymentIntentId): Promise<PaymentIntentEntity | null> {
    return this.lockForUpdate(id, manager);
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
      payment_method_token: PaymentIntentEntity['payment_method_token'];
      payment_method_id: PaymentMethodId | null;
      latest_charge_id: ChargeId | null;
      next_action: PaymentIntentEntity['next_action'];
      canceled_at: Date | null;
      cancellation_reason: CancellationReason | null;
      review_id: ReviewId | null;
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

  /**
   * RFC platform-v2 §7. Re-prices an intent that has not been confirmed yet: the shopper chose to
   * pay in another currency (or switched back). Conditional on the intent still waiting for a
   * payment method, so a price can never change under an authorisation.
   */
  async applyPresentment(
    manager: EntityManager,
    id: PaymentIntentId,
    price: { amount_minor: number; currency: CurrencyCode; presentment: Presentment | null },
  ): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(PaymentIntentEntity)
      .set(price)
      .where('id = :id', { id })
      .andWhere('status in (:...open)', { open: ['requires_payment_method', 'requires_confirmation'] })
      .execute();
    return result.affected ?? 0;
  }

  /** §5/§6 links written after the fact: the card saved at completion, the subscription it started. */
  async linkBilling(
    manager: EntityManager,
    id: PaymentIntentId,
    links: Partial<{ payment_method_id: PaymentMethodId; subscription_id: SubscriptionId; customer_id: string }>,
  ): Promise<void> {
    await manager.createQueryBuilder().update(PaymentIntentEntity).set(links).where('id = :id', { id }).execute();
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
    scope: MerchantScope,
    id: PaymentIntentId,
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.updateScoped(id, scope, { metadata } as never);
  }

  countByStatus(merchantId: MerchantId, status: PaymentIntentStatus): Promise<number> {
    return this.count({
      where: { merchant_id: merchantId, status } as FindOptionsWhere<PaymentIntentEntity>,
    });
  }
}
