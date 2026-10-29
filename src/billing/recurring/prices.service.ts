/**
 * PricesService — L7. RFC platform-v2 §6. What a merchant charges, once or every period.
 *
 * Prices are immutable: a subscription renews at the price it started on, so a new amount is a
 * new price. `requireRecurring` is the one check checkout and `POST /v1/subscriptions` share.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { AuthPrincipal, Paginated, Price, PriceId } from '@payzeno/contracts';

import { livemodeOf, merchantIdOf } from '../../auth/principal/principal.factory';
import { BaseService } from '../../common/base/base.service';
import type { MerchantScope } from '../../common/base/merchant-scoped.entity';
import { ValidationException } from '../../common/errors/api.exception';
import { ResourceNotFoundException } from '../../common/errors/not-found.exceptions';
import { IdFactory } from '../../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { resolveListQuery, type ResolvedListQuery } from '../../common/pagination/list-query.dto';
import { CLOCK, type Clock } from '../../common/time/clock';

import type { CreatePriceDto } from './dto/price.dto';
import { PRICE_ID_PREFIX, PriceEntity, toPrice } from './price.entity';
import { PriceRepository } from './price.repository';

@Injectable()
export class PricesService extends BaseService<PriceEntity> {
  constructor(
    private readonly prices: PriceRepository,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(prices, logger);
  }

  get entityName(): string {
    return 'price';
  }

  async create(principal: AuthPrincipal, dto: CreatePriceDto): Promise<Price> {
    const row = await this.createInternal(scopeFrom(principal), dto);
    return toPrice(row);
  }

  /** The API create and the demo price seed share this. */
  async createInternal(scope: MerchantScope, dto: CreatePriceDto): Promise<PriceEntity> {
    const now = this.clock.now();
    const row = new PriceEntity();
    row.id = this.ids.opaque(PRICE_ID_PREFIX);
    row.merchantId = scope.merchantId;
    row.livemode = scope.livemode;
    row.productName = dto.product_name;
    row.unitAmountMinor = dto.unit_amount_minor;
    row.currency = dto.currency;
    row.recurringInterval = dto.recurring?.interval ?? null;
    row.recurringIntervalCount = dto.recurring?.interval_count ?? null;
    row.active = true;
    row.metadata = dto.metadata ?? {};
    row.createdAt = now;
    row.updatedAt = now;

    await this.prices.insertPrice(row);
    this.logger.info('price_created', { price_id: row.id, merchant_id: scope.merchantId, recurring: row.recurringInterval });
    return row;
  }

  async get(principal: AuthPrincipal, id: PriceId): Promise<Price> {
    return toPrice(await this.findOneOrThrow(id, scopeFrom(principal)));
  }

  async list(principal: AuthPrincipal, query: { cursor?: string; limit?: number }, active?: boolean): Promise<Paginated<Price>> {
    const page = await this.listScoped(scopeFrom(principal), resolveListQuery(query), active);
    return { ...page, data: page.data.map(toPrice) };
  }

  listScoped(scope: MerchantScope, query: ResolvedListQuery, active?: boolean): Promise<Paginated<PriceEntity>> {
    return this.prices.listScoped(scope, query, active);
  }

  /** An active, recurring price in scope — the only kind that can start a subscription. */
  async requireRecurring(scope: MerchantScope, id: PriceId, path = 'price_id'): Promise<PriceEntity> {
    const row = await this.findOneOrThrow(id, scope);
    if (!row.active || !row.recurring()) {
      throw new ValidationException('A subscription needs an active recurring price', [
        { path, code: 'not_recurring', message: `${id} is ${row.active ? 'a one-off price' : 'archived'}` },
      ]);
    }
    return row;
  }

  protected override notFound(id: string): ResourceNotFoundException {
    return new ResourceNotFoundException('price', id);
  }
}

function scopeFrom(principal: AuthPrincipal): MerchantScope {
  return { merchantId: merchantIdOf(principal), livemode: livemodeOf(principal) };
}
