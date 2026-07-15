/**
 * PayzenoRepository<T> — the persistence layer, not a synonym for `repo.find()`.
 *
 * Extends TypeORM's Repository<T> so the twelve entity repositories inherit `save`, `insert`
 * and the query builder, and adds the four operations that every one of them needs and that
 * nobody should re-implement:
 *
 *   findScoped        tenant + livemode predicate, applied ALWAYS. A repository method that
 *                     takes a bare id and no scope is how one merchant reads another's charge.
 *   paginateCursor    keyset pagination over `(created_at, id)` — see cursor.ts.
 *   lockForUpdate     SELECT … FOR UPDATE inside the caller's transaction. RefundPolicyService
 *                     re-reads `charge.refunded_amount_minor` through this before it decides.
 *   updateScoped      conditional UPDATE returning the affected count, so a state transition
 *                     that lost a race returns 0 rather than silently overwriting.
 *
 * Layer rule: this file may import entities, primitives and config. It may not import a
 * service. docs/adr/0001-nestjs-module-boundaries.md.
 */
import {
  Repository,
  type EntityManager,
  type FindOptionsWhere,
  type ObjectLiteral,
  type SelectQueryBuilder,
} from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import type { Paginated } from '@payzeno/contracts';

import type { MerchantScope } from '../base/merchant-scoped.entity';
import type { ResolvedListQuery } from '../pagination/list-query.dto';

import { applyCursor, toPage, type CursorRow } from './cursor';
import { mapTypeOrmError } from './typeorm-error.mapper';

export abstract class PayzenoRepository<T extends ObjectLiteral & CursorRow> extends Repository<T> {
  /** Query-builder alias. Subclasses set it; every generated predicate uses it. */
  protected abstract get alias(): string;

  /** Column holding the tenant. Overridden by Merchant, whose tenant column is `id`. */
  protected get scopeColumn(): string {
    return 'merchant_id';
  }

  /** A builder already narrowed to one tenant and one mode. The only entry point that is. */
  scopedQuery(scope: MerchantScope, manager?: EntityManager): SelectQueryBuilder<T> {
    const repo = manager ? manager.getRepository<T>(this.target) : this;
    return repo
      .createQueryBuilder(this.alias)
      .where(`${this.alias}.${this.scopeColumn} = :merchantId`, { merchantId: scope.merchantId })
      .andWhere(`${this.alias}.livemode = :livemode`, { livemode: scope.livemode });
  }

  /** Returns null rather than throwing; the service decides which NotFound subclass applies. */
  async findScoped(id: string, scope: MerchantScope, manager?: EntityManager): Promise<T | null> {
    return this.scopedQuery(scope, manager).andWhere(`${this.alias}.id = :id`, { id }).getOne();
  }

  async existsScoped(id: string, scope: MerchantScope): Promise<boolean> {
    const count = await this.scopedQuery(scope).andWhere(`${this.alias}.id = :id`, { id }).getCount();
    return count > 0;
  }

  /**
   * Keyset page within a tenant. `extend` lets the caller add feature predicates (status,
   * charge_id, …) without leaving the scoped builder.
   */
  async paginateCursor(
    scope: MerchantScope,
    query: ResolvedListQuery,
    extend?: (qb: SelectQueryBuilder<T>) => SelectQueryBuilder<T>,
  ): Promise<Paginated<T>> {
    let qb = this.scopedQuery(scope);

    if (query.createdAfter) {
      qb = qb.andWhere(`${this.alias}.created_at > :createdAfter`, { createdAfter: query.createdAfter });
    }
    if (query.createdBefore) {
      qb = qb.andWhere(`${this.alias}.created_at < :createdBefore`, { createdBefore: query.createdBefore });
    }
    if (extend) {
      qb = extend(qb);
    }

    const rows = await applyCursor(qb, {
      limit: query.limit,
      cursor: query.cursor,
      alias: this.alias,
    }).getMany();

    return toPage(rows, query.limit);
  }

  /**
   * Row lock inside an existing transaction. `manager` is required on purpose: a FOR UPDATE
   * outside a transaction takes a lock and drops it on the next statement, which reads as
   * working and protects nothing.
   */
  async lockForUpdate(id: string, manager: EntityManager): Promise<T | null> {
    return manager
      .getRepository<T>(this.target)
      .createQueryBuilder(this.alias)
      .setLock('pessimistic_write')
      .where(`${this.alias}.id = :id`, { id })
      .getOne();
  }

  /**
   * Conditional scoped update. Returns rows affected — 0 means the predicate no longer held,
   * which for a state transition means somebody else got there first.
   */
  async updateScoped(
    id: string,
    scope: MerchantScope,
    patch: QueryDeepPartialEntity<T>,
    extraWhere?: FindOptionsWhere<T>,
    manager?: EntityManager,
  ): Promise<number> {
    const repo = manager ? manager.getRepository<T>(this.target) : this;

    try {
      const result = await repo
        .createQueryBuilder()
        .update()
        .set(patch)
        .where('id = :id', { id })
        .andWhere(`${this.scopeColumn} = :merchantId`, { merchantId: scope.merchantId })
        .andWhere('livemode = :livemode', { livemode: scope.livemode })
        .andWhere(extraWhere ?? {})
        .execute();

      return result.affected ?? 0;
    } catch (err) {
      throw mapTypeOrmError(err);
    }
  }

  /** Insert that translates 23505 into the right business exception. */
  async insertMapped(entity: QueryDeepPartialEntity<T>, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository<T>(this.target) : this;
    try {
      await repo.insert(entity);
    } catch (err) {
      throw mapTypeOrmError(err);
    }
  }
}
