/**
 * `price` — what a merchant charges for a product, once or every period. RFC platform-v2 §6.
 * Migration platform-v2 money 2.
 *
 * Prices are immutable apart from `active`: a subscription renews at the price it started on,
 * so changing an amount means a new price, never an edit under a running subscription.
 */
import type { CurrencyCode, Metadata, Price, Recurring, RecurringInterval } from '@payzeno/contracts';
import { Column, Entity, Index } from 'typeorm';

import { MerchantScopedEntity } from '../../common/base/merchant-scoped.entity';
import { currencyTransformer, requiredMinorUnitsTransformer } from '../../common/typeorm/minor-units.transformer';

/** `price_`. Minted through `IdFactory.opaque` until the prefix joins `API_ID_PREFIXES`. */
export const PRICE_ID_PREFIX = 'price_';

@Entity({ name: 'price' })
@Index('ix_price_merchant_created', ['merchantId', 'livemode', 'createdAt'])
export class PriceEntity extends MerchantScopedEntity {
  @Column({ type: 'text', name: 'product_name' })
  productName!: string;

  @Column({ type: 'bigint', name: 'unit_amount_minor', transformer: requiredMinorUnitsTransformer })
  unitAmountMinor!: number;

  @Column({ type: 'char', length: 3, transformer: currencyTransformer })
  currency!: CurrencyCode;

  @Column({ type: 'text', name: 'recurring_interval', nullable: true })
  recurringInterval!: RecurringInterval | null;

  @Column({ type: 'smallint', name: 'recurring_interval_count', nullable: true })
  recurringIntervalCount!: number | null;

  @Column({ type: 'boolean', default: true })
  active!: boolean;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Metadata;

  recurring(): Recurring | null {
    if (!this.recurringInterval || !this.recurringIntervalCount) return null;
    return { interval: this.recurringInterval, interval_count: this.recurringIntervalCount };
  }
}

export function toPrice(row: PriceEntity): Price {
  return {
    id: row.id,
    object: 'price',
    merchant_id: row.merchantId,
    product_name: row.productName,
    unit_amount_minor: Number(row.unitAmountMinor),
    currency: row.currency,
    recurring: row.recurring(),
    active: row.active,
    livemode: row.livemode,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
  };
}
