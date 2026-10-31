/**
 * `fx_quote` — what a shopper was shown, RFC platform-v2 §7. Migration platform-v2 money 3.
 *
 * Append-only and not merchant-scoped: a quote is a fact about a rate at a moment, valid for
 * 30 minutes. The checkout session it was offered on is recorded so a confirm can only spend a
 * quote its own session was shown. `numeric` columns come back from the driver as strings,
 * which is exactly the wire format for a rate.
 */
import type { CheckoutSessionId, CurrencyCode, FxQuote } from '@payzeno/contracts';
import { Column, Entity } from 'typeorm';

import { AppendOnlyEntity } from '../common/base/base.entity';
import { currencyTransformer } from '../common/typeorm/minor-units.transformer';

/** `fxq_`. Minted through `IdFactory.opaque` until the prefix joins `API_ID_PREFIXES`. */
export const FX_QUOTE_ID_PREFIX = 'fxq_';

/** RFC §7: a quote is honoured for 30 minutes. */
export const FX_QUOTE_TTL_MS = 30 * 60 * 1000;

/** Trailing zeros off a `numeric(24,10)` read ("0.9415620000" → "0.941562"). */
const decimalTransformer = {
  to: (value: string): string => value,
  from: (value: string | null): string | null =>
    value === null ? null : value.includes('.') ? value.replace(/\.?0+$/, '') : value,
};

@Entity({ name: 'fx_quote' })
export class FxQuoteEntity extends AppendOnlyEntity {
  @Column({ type: 'char', length: 3, name: 'from_currency', transformer: currencyTransformer })
  fromCurrency!: CurrencyCode;

  @Column({ type: 'char', length: 3, name: 'to_currency', transformer: currencyTransformer })
  toCurrency!: CurrencyCode;

  @Column({ type: 'numeric', precision: 24, scale: 10, name: 'mid_rate', transformer: decimalTransformer })
  midRate!: string;

  @Column({ type: 'integer', name: 'markup_bps' })
  markupBps!: number;

  @Column({ type: 'numeric', precision: 24, scale: 10, transformer: decimalTransformer })
  rate!: string;

  @Column({ type: 'timestamptz', name: 'provider_as_of', nullable: true })
  providerAsOf!: Date | null;

  @Column({ type: 'text', name: 'checkout_session_id', nullable: true })
  checkoutSessionId!: CheckoutSessionId | null;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;
}

export function toFxQuote(row: FxQuoteEntity): FxQuote {
  return {
    id: row.id,
    object: 'fx_quote',
    from_currency: row.fromCurrency,
    to_currency: row.toCurrency,
    mid_rate: row.midRate,
    markup_bps: row.markupBps,
    rate: row.rate,
    expires_at: row.expiresAt.toISOString(),
  };
}
