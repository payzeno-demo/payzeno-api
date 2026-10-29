/**
 * FxService — L4. Mid-rates, checkout quotes and conversion. RFC platform-v2 §7.
 *
 * Rates are cached in-process for a minute (`RATE_CACHE_MS`); a provider failure is cached for
 * ten seconds so a dead vendor costs one timeout per ten seconds rather than one per page load.
 * Every failure is **fail closed**: no rate, so no quote, so checkout offers no currency options
 * and the shopper pays in the session's own currency. Nobody is ever charged at a guessed rate.
 *
 * Quotes are what a shopper is shown and what a confirm spends: provider mid × (1 + markup),
 * valid for 30 minutes, tied to the checkout session that displayed them. A session that is
 * re-read keeps getting the same quote while it has more than five minutes left, so the price
 * on the page does not twitch every time the page polls.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CURRENCIES, type CheckoutSessionId, type CurrencyCode, type FxQuoteId } from '@payzeno/contracts';

import { ValidationException } from '../common/errors/api.exception';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';

import { applyMarkup, convertMinor, crossRate, isPositiveDecimal } from './fx-math';
import { FX_QUOTE_ID_PREFIX, FX_QUOTE_TTL_MS, FxQuoteEntity } from './fx-quote.entity';
import { FxQuoteRepository } from './fx-quote.repository';
import { FxRatesClient } from './fx-rates.client';

export const RATE_CACHE_MS = 60_000;
const FAILURE_CACHE_MS = 10_000;
/** A reused quote must still have this long to run, or the shopper could be mid-typing when it lapses. */
const QUOTE_REUSE_MARGIN_MS = 5 * 60 * 1000;
const PROVIDER_BASE: CurrencyCode = 'USD';

interface RateTable {
  fetchedAtMs: number;
  asOf: Date | null;
  /** Units of each currency per one USD. Null after a failed fetch (cached briefly). */
  perBase: Map<CurrencyCode, string> | null;
}

export interface MidRate {
  mid: string;
  asOf: Date | null;
}

@Injectable()
export class FxService {
  private table: RateTable | null = null;
  private inflight: Promise<RateTable> | null = null;

  constructor(
    private readonly quotes: FxQuoteRepository,
    private readonly ids: IdFactory,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
    // Explicit token: the union type would otherwise be emitted as `Object` and never resolve.
    @Optional() @Inject(FxRatesClient) private readonly provider: FxRatesClient | null = null,
  ) {}

  get checkoutMarkupBps(): number {
    return this.config.money.fxCheckoutMarkupBps;
  }

  /** `to` per one `from` at the provider's mid, or null when there is no trustworthy rate. */
  async midRate(from: CurrencyCode, to: CurrencyCode): Promise<MidRate | null> {
    if (from === to) return null;
    const table = await this.rates();
    if (!table.perBase) return null;

    const fromPerBase = table.perBase.get(from);
    const toPerBase = table.perBase.get(to);
    if (!fromPerBase || !toPerBase) return null;

    return { mid: crossRate(fromPerBase, toPerBase), asOf: table.asOf };
  }

  /**
   * The quote a checkout session shows for paying in `to`. Reuses the session's live quote for
   * the pair when it has five minutes or more left; otherwise prices a new one. Null = no rate.
   */
  async quoteForSession(
    checkoutSessionId: CheckoutSessionId,
    from: CurrencyCode,
    to: CurrencyCode,
  ): Promise<FxQuoteEntity | null> {
    const now = this.clock.now();
    const reusable = await this.quotes.findReusable(
      checkoutSessionId,
      from,
      to,
      new Date(now.getTime() + QUOTE_REUSE_MARGIN_MS),
    );
    if (reusable) return reusable;

    const mid = await this.midRate(from, to);
    if (!mid) return null;

    const row = new FxQuoteEntity();
    row.id = this.ids.opaque(FX_QUOTE_ID_PREFIX);
    row.fromCurrency = from;
    row.toCurrency = to;
    row.midRate = mid.mid;
    row.markupBps = this.checkoutMarkupBps;
    row.rate = applyMarkup(mid.mid, this.checkoutMarkupBps);
    row.providerAsOf = mid.asOf;
    row.checkoutSessionId = checkoutSessionId;
    row.expiresAt = new Date(now.getTime() + FX_QUOTE_TTL_MS);
    row.createdAt = now;

    await this.quotes.insertQuote(row);
    this.logger.info('fx_quote_created', {
      fx_quote_id: row.id,
      checkout_session_id: checkoutSessionId,
      from,
      to,
      rate: row.rate,
    });
    return row;
  }

  /**
   * The quote a confirm wants to spend. It must exist, be for exactly this pair and session,
   * and not have expired — anything else is a 422 that tells the page to re-read the session
   * (which prices a fresh quote).
   */
  async requireSpendableQuote(
    id: FxQuoteId,
    checkoutSessionId: CheckoutSessionId,
    from: CurrencyCode,
    to: CurrencyCode,
  ): Promise<FxQuoteEntity> {
    const quote = await this.quotes.findById(id);
    const fail = (message: string): never => {
      throw new ValidationException(message, [{ path: 'fx_quote_id', code: 'invalid_quote', message }]);
    };

    if (!quote || quote.checkoutSessionId !== checkoutSessionId) {
      return fail('This currency quote does not belong to this checkout session');
    }
    if (quote.fromCurrency !== from || quote.toCurrency !== to) {
      return fail(`This quote converts ${quote.fromCurrency} to ${quote.toCurrency}, not ${from} to ${to}`);
    }
    if (quote.expiresAt.getTime() <= this.clock.nowMs()) {
      return fail('This currency quote has expired; reload the page for a fresh price');
    }
    return quote;
  }

  convert(amountMinor: number, from: CurrencyCode, to: CurrencyCode, rate: string): number {
    return convertMinor(amountMinor, from, to, rate);
  }

  // -- rate table ----------------------------------------------------------------

  private async rates(): Promise<RateTable> {
    const nowMs = this.clock.nowMs();
    const table = this.table;
    if (table) {
      const ttl = table.perBase ? RATE_CACHE_MS : FAILURE_CACHE_MS;
      // `nowMs < fetchedAtMs` is a clock that moved backwards: refetch rather than trust it.
      if (nowMs >= table.fetchedAtMs && nowMs - table.fetchedAtMs < ttl) return table;
    }

    // One fetch at a time; concurrent page loads share it.
    if (!this.inflight) {
      this.inflight = this.fetch(nowMs).finally(() => {
        this.inflight = null;
      });
    }
    this.table = await this.inflight;
    return this.table;
  }

  private async fetch(nowMs: number): Promise<RateTable> {
    if (!this.provider) {
      this.logger.debug('fx_rates_unconfigured', {});
      return { fetchedAtMs: nowMs, asOf: null, perBase: null };
    }

    try {
      const body = await this.provider.latest(PROVIDER_BASE);
      if (body.base !== PROVIDER_BASE || typeof body.rates !== 'object' || body.rates === null) {
        throw new Error(`unexpected rates payload for base ${String(body.base)}`);
      }

      const perBase = new Map<CurrencyCode, string>([[PROVIDER_BASE, '1']]);
      for (const currency of CURRENCIES) {
        const value = body.rates[currency];
        if (currency !== PROVIDER_BASE && typeof value === 'string' && isPositiveDecimal(value)) {
          perBase.set(currency, value.trim());
        }
      }

      const asOf = body.as_of ? new Date(body.as_of) : null;
      return { fetchedAtMs: nowMs, asOf: asOf && !Number.isNaN(asOf.getTime()) ? asOf : null, perBase };
    } catch (err) {
      this.logger.warn('fx_rates_unavailable', { error: err instanceof Error ? err.message : 'unknown' });
      return { fetchedAtMs: nowMs, asOf: null, perBase: null };
    }
  }
}
