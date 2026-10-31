/**
 * L1. The only writer of `customer`.
 *
 * Every read is scoped by merchant and mode (`PayzenoRepository.scopedQuery`): a customer id
 * from another tenant, or from the other mode, is simply not found.
 */
import { Injectable } from '@nestjs/common';
import type { CustomerId, Paginated, PaymentMethodId } from '@payzeno/contracts';
import { DataSource, type EntityManager } from 'typeorm';

import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import type { ResolvedListQuery } from '../common/pagination/list-query.dto';
import { PayzenoRepository, toInsertRow } from '../common/persistence/payzeno.repository';

import { CustomerEntity } from './customer.entity';

export type CustomerPatch = Partial<Pick<CustomerEntity, 'email' | 'name' | 'defaultPaymentMethodId' | 'metadata'>>;

@Injectable()
export class CustomerRepository extends PayzenoRepository<CustomerEntity> {
  constructor(dataSource: DataSource) {
    super(CustomerEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'customer';
  }

  async insertCustomer(row: CustomerEntity, manager?: EntityManager): Promise<CustomerEntity> {
    await this.insertMapped(toInsertRow(row), manager);
    return row;
  }

  listScoped(scope: MerchantScope, query: ResolvedListQuery, email?: string): Promise<Paginated<CustomerEntity>> {
    return this.paginateCursor(scope, query, (qb) =>
      email ? qb.andWhere('customer.email = :email', { email }) : qb,
    );
  }

  async patch(scope: MerchantScope, id: CustomerId, patch: CustomerPatch, manager?: EntityManager): Promise<number> {
    return this.updateScoped(id, scope, patch, undefined, manager);
  }

  /**
   * The first card saved becomes the default; a later one only when the caller says so. The
   * `onlyIfUnset` predicate is in the WHERE clause so two concurrent saves cannot both win.
   */
  async setDefaultPaymentMethod(
    manager: EntityManager,
    id: CustomerId,
    paymentMethodId: PaymentMethodId,
    onlyIfUnset: boolean,
  ): Promise<void> {
    const qb = manager
      .createQueryBuilder()
      .update(CustomerEntity)
      .set({ defaultPaymentMethodId: paymentMethodId })
      .where('id = :id', { id });
    if (onlyIfUnset) qb.andWhere('default_payment_method_id is null');
    await qb.execute();
  }

  /** A detached card stops being anybody's default. */
  async clearDefaultPaymentMethod(manager: EntityManager, paymentMethodId: PaymentMethodId): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(CustomerEntity)
      .set({ defaultPaymentMethodId: null })
      .where('default_payment_method_id = :paymentMethodId', { paymentMethodId })
      .execute();
  }
}
