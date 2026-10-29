/** L1. The only writer of `price`. */
import { Injectable } from '@nestjs/common';
import type { Paginated } from '@payzeno/contracts';
import { DataSource } from 'typeorm';

import type { MerchantScope } from '../../common/base/merchant-scoped.entity';
import type { ResolvedListQuery } from '../../common/pagination/list-query.dto';
import { PayzenoRepository, toInsertRow } from '../../common/persistence/payzeno.repository';

import { PriceEntity } from './price.entity';

@Injectable()
export class PriceRepository extends PayzenoRepository<PriceEntity> {
  constructor(dataSource: DataSource) {
    super(PriceEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'price';
  }

  async insertPrice(row: PriceEntity): Promise<PriceEntity> {
    await this.insertMapped(toInsertRow(row));
    return row;
  }

  listScoped(scope: MerchantScope, query: ResolvedListQuery, active?: boolean): Promise<Paginated<PriceEntity>> {
    return this.paginateCursor(scope, query, (qb) =>
      active === undefined ? qb : qb.andWhere('price.active = :active', { active }),
    );
  }

  /** Unscoped by-id read for the renewal job, which already holds the subscription's scope. */
  findById(id: string): Promise<PriceEntity | null> {
    return this.findOne({ where: { id } });
  }
}
