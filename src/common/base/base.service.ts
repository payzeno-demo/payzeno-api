/**
 * BaseService<TEntity> — the application-service root.
 *
 * Eight services extend it: MerchantsService, PaymentIntentsService, ChargesService,
 * RefundsService, DisputesService, ApiKeysService, BankAccountsService,
 * WebhookEndpointsService.
 *
 * What it owns is small and non-negotiable: the tenant-scoped fetch that throws the right
 * 404, and the paginate call. What it deliberately does NOT own is business logic — a
 * subclass that only calls super is a subclass that should have been a repository.
 */
import type { FindOptionsWhere, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import type { ListQuery, Paginated } from '@payzeno/contracts';

import { ResourceNotFoundException } from '../errors/not-found.exceptions';
import type { PayzenoLogger } from '../logging/logger';
import { resolveListQuery } from '../pagination/list-query.dto';
import type { CursorRow } from '../persistence/cursor';
import type { PayzenoRepository } from '../persistence/payzeno.repository';

import type { MerchantScope } from './merchant-scoped.entity';

export abstract class BaseService<TEntity extends ObjectLiteral & CursorRow> {
  protected constructor(
    protected readonly repo: PayzenoRepository<TEntity>,
    protected readonly logger: PayzenoLogger,
  ) {}

  /** Used in the 404 message and as `audit_log.resource_type`. e.g. `payment_intent`. */
  abstract get entityName(): string;

  /**
   * Override to throw the aggregate's own subclass (PaymentIntentNotFoundException, …).
   * The default is correct but generic, and a generic 404 is harder to attribute in a graph.
   */
  protected notFound(id: string): ResourceNotFoundException {
    return new ResourceNotFoundException(this.entityName, id);
  }

  protected async findOneOrThrow(id: string, scope: MerchantScope): Promise<TEntity> {
    const found = await this.repo.findScoped(id, scope);

    if (!found) {
      // Debug, not warn: a merchant polling a deleted id is not an operational event.
      this.logger.debug('entity not found in scope', {
        entity: this.entityName,
        id,
        merchant_id: scope.merchantId,
        livemode: scope.livemode,
      });
      throw this.notFound(id);
    }

    return found;
  }

  protected async paginate(
    query: ListQuery,
    scope: MerchantScope,
    extend?: (qb: SelectQueryBuilder<TEntity>) => SelectQueryBuilder<TEntity>,
  ): Promise<Paginated<TEntity>> {
    return this.repo.paginateCursor(scope, resolveListQuery(query), extend);
  }

  /** Convenience for feature predicates expressed as a plain where clause. */
  protected async paginateWhere(
    query: ListQuery,
    scope: MerchantScope,
    where: FindOptionsWhere<TEntity>,
  ): Promise<Paginated<TEntity>> {
    return this.paginate(query, scope, (qb) => qb.andWhere(where));
  }
}
