/**
 * L1. The only writer of `payment_method`.
 *
 * Reads exclude detached cards unless a method says otherwise: a detached card is history, not
 * something a shopper can pay with.
 */
import { Injectable } from '@nestjs/common';
import type { CustomerId, PaymentMethodId } from '@payzeno/contracts';
import { DataSource, type EntityManager } from 'typeorm';

import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { PayzenoRepository, toInsertRow } from '../common/persistence/payzeno.repository';

import { PaymentMethodEntity } from './payment-method.entity';

/** A customer has a handful of cards, not pages of them. */
const MAX_CARDS_LISTED = 50;

@Injectable()
export class PaymentMethodRepository extends PayzenoRepository<PaymentMethodEntity> {
  constructor(dataSource: DataSource) {
    super(PaymentMethodEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'payment_method';
  }

  findAttached(scope: MerchantScope, id: PaymentMethodId, manager?: EntityManager): Promise<PaymentMethodEntity | null> {
    return this.scopedQuery(scope, manager)
      .andWhere('payment_method.id = :id', { id })
      .andWhere('payment_method.detached_at is null')
      .getOne();
  }

  listAttached(scope: MerchantScope, customerId: CustomerId): Promise<PaymentMethodEntity[]> {
    return this.scopedQuery(scope)
      .andWhere('payment_method.customer_id = :customerId', { customerId })
      .andWhere('payment_method.detached_at is null')
      .orderBy('payment_method.created_at', 'DESC')
      .take(MAX_CARDS_LISTED)
      .getMany();
  }

  /** `uq_payment_method_customer_fingerprint`'s lookup: the same card saved twice is one row. */
  findAttachedByFingerprint(
    manager: EntityManager,
    customerId: CustomerId,
    fingerprint: string,
  ): Promise<PaymentMethodEntity | null> {
    return manager
      .getRepository(PaymentMethodEntity)
      .createQueryBuilder('payment_method')
      .where('payment_method.customer_id = :customerId', { customerId })
      .andWhere('payment_method.fingerprint = :fingerprint', { fingerprint })
      .andWhere('payment_method.detached_at is null')
      .getOne();
  }

  async insertPaymentMethod(manager: EntityManager, row: PaymentMethodEntity): Promise<PaymentMethodEntity> {
    await this.insertMapped(toInsertRow(row), manager);
    return row;
  }

  async markDetached(manager: EntityManager, id: PaymentMethodId, at: Date): Promise<number> {
    const result = await manager
      .createQueryBuilder()
      .update(PaymentMethodEntity)
      .set({ detachedAt: at })
      .where('id = :id AND detached_at is null', { id })
      .execute();
    return result.affected ?? 0;
  }
}
