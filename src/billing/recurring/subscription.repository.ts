/**
 * L1. The only writer of `customer_subscription`.
 *
 * Every state write that the renewal job and a request can race on (renew, fail, cancel) takes
 * the row lock first (`lockSubscription`) inside the caller's transaction — a setup session
 * fixing a card at the same second the job retries must not charge twice for one period.
 */
import { Injectable } from '@nestjs/common';
import type { CustomerId, Paginated, SubscriptionStatus } from '@payzeno/contracts';
import { DataSource, type EntityManager } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import type { MerchantScope } from '../../common/base/merchant-scoped.entity';
import type { ResolvedListQuery } from '../../common/pagination/list-query.dto';
import { PayzenoRepository, toInsertRow } from '../../common/persistence/payzeno.repository';

import { SubscriptionEntity } from './subscription.entity';

export type SubscriptionPatch = QueryDeepPartialEntity<SubscriptionEntity>;

@Injectable()
export class SubscriptionRepository extends PayzenoRepository<SubscriptionEntity> {
  constructor(dataSource: DataSource) {
    super(SubscriptionEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'customer_subscription';
  }

  async insertSubscription(manager: EntityManager, row: SubscriptionEntity): Promise<SubscriptionEntity> {
    await this.insertMapped(toInsertRow(row), manager);
    return row;
  }

  listScoped(
    scope: MerchantScope,
    query: ResolvedListQuery,
    filters: { customerId?: CustomerId; status?: SubscriptionStatus },
  ): Promise<Paginated<SubscriptionEntity>> {
    return this.paginateCursor(scope, query, (qb) => {
      let builder = qb;
      if (filters.customerId) {
        builder = builder.andWhere('customer_subscription.customer_id = :customerId', { customerId: filters.customerId });
      }
      if (filters.status) {
        builder = builder.andWhere('customer_subscription.status = :status', { status: filters.status });
      }
      return builder;
    });
  }

  lockSubscription(manager: EntityManager, id: string): Promise<SubscriptionEntity | null> {
    return this.lockForUpdate(id, manager);
  }

  async patch(manager: EntityManager, id: string, patch: SubscriptionPatch): Promise<void> {
    await manager.createQueryBuilder().update(SubscriptionEntity).set(patch).where('id = :id', { id }).execute();
  }

  /**
   * What `SubscriptionRenewalJob` works on: active subscriptions whose period has ended, and
   * past-due ones whose retry is due. Rides the two partial indexes of migration money 2.
   */
  findDue(now: Date, limit: number): Promise<SubscriptionEntity[]> {
    return this.createQueryBuilder('customer_subscription')
      .where(
        `(customer_subscription.status = 'active' and customer_subscription.current_period_end <= :now)
         or (customer_subscription.status = 'past_due' and customer_subscription.next_retry_at <= :now)`,
        { now },
      )
      .orderBy('customer_subscription.current_period_end', 'ASC')
      .limit(limit)
      .getMany();
  }
}
