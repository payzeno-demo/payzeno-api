/**
 * L1. The only writer of `checkout_session`.
 *
 * Status writes are conditional on the status they expect, like every other state column in
 * this schema: the lazy reconcile on read, the confirm path and `CheckoutExpiryJob` can all reach
 * the same row, and the loser of a race must affect zero rows rather than overwrite.
 */
import { Injectable } from '@nestjs/common';
import type { CheckoutSessionStatus, Paginated } from '@payzeno/contracts';
import { DataSource, type EntityManager } from 'typeorm';


import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import type { ResolvedListQuery } from '../common/pagination/list-query.dto';
import { PayzenoRepository } from '../common/persistence/payzeno.repository';

import { CheckoutSessionEntity } from './checkout-session.entity';

@Injectable()
export class CheckoutSessionRepository extends PayzenoRepository<CheckoutSessionEntity> {
  constructor(dataSource: DataSource) {
    super(CheckoutSessionEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'checkout_session';
  }

  listScoped(
    scope: MerchantScope,
    query: ResolvedListQuery,
    status?: CheckoutSessionStatus,
  ): Promise<Paginated<CheckoutSessionEntity>> {
    return this.paginateCursor(scope, query, (qb) =>
      status ? qb.andWhere('checkout_session.status = :status', { status }) : qb,
    );
  }

  /** `CheckoutSecretGuard`'s lookup. The secret is the credential; it carries its own scope. */
  findByClientSecret(clientSecret: string): Promise<CheckoutSessionEntity | null> {
    return this.findOne({ where: { clientSecret } });
  }

  async insertSession(manager: EntityManager, row: CheckoutSessionEntity): Promise<void> {
    await this.insertMapped(row, manager);
  }

  /**
   * `open → complete`. Returns rows affected; 0 means another path already moved it. With a
   * manager it joins the transaction that does the completion's work (save the card, start the
   * subscription), so the session is complete exactly when that work committed.
   */
  async markComplete(id: string, completedAt: Date, manager?: EntityManager): Promise<number> {
    const result = await (manager ?? this.manager)
      .createQueryBuilder()
      .update(CheckoutSessionEntity)
      .set({ status: 'complete', completedAt })
      .where('id = :id AND status = :expected', { id, expected: 'open' })
      .execute();
    return result.affected ?? 0;
  }

  /** RFC platform-v2 links and flags written after create: the customer, the subscription, "save card". */
  async patchSession(
    id: string,
    patch: Partial<Pick<CheckoutSessionEntity, 'customerId' | 'subscriptionId' | 'saveCardRequested'>>,
    manager?: EntityManager,
  ): Promise<void> {
    await (manager ?? this.manager)
      .createQueryBuilder()
      .update(CheckoutSessionEntity)
      .set(patch)
      .where('id = :id', { id })
      .execute();
  }

  /** `open → expired`. Returns rows affected; 0 means it completed or expired already. */
  async markExpired(id: string): Promise<number> {
    const result = await this.createQueryBuilder()
      .update(CheckoutSessionEntity)
      .set({ status: 'expired' })
      .where('id = :id AND status = :expected', { id, expected: 'open' })
      .execute();
    return result.affected ?? 0;
  }

  /** Rides `pix_checkout_session_open_expiry`. `CheckoutExpiryJob`'s input. */
  findOpenPastExpiry(now: Date, limit: number): Promise<CheckoutSessionEntity[]> {
    return this.createQueryBuilder('checkout_session')
      .where("checkout_session.status = 'open'")
      .andWhere('checkout_session.expires_at <= :now', { now })
      .orderBy('checkout_session.expires_at', 'ASC')
      .limit(limit)
      .getMany();
  }
}
