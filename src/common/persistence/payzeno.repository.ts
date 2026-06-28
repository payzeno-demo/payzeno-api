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

  /** Returns null rather than throwing; the service decides which NotFound subclass applies. */
  async findScoped(id: string, scope: MerchantScope, manager?: EntityManager): Promise<T | null> {
    return this.scopedQuery(scope, manager).andWhere(`${this.alias}.id = :id`, { id }).getOne();
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
