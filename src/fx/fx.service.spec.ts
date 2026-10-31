import { ValidationException } from 'src/common/errors/api.exception';
import type { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import type { ApiConfig } from 'src/config/api-config.type';
import { FxQuoteEntity } from 'src/fx/fx-quote.entity';
import type { FxQuoteRepository } from 'src/fx/fx-quote.repository';
import type { FxRatesClient, FxRatesResponse } from 'src/fx/fx-rates.client';
import { FxService, RATE_CACHE_MS } from 'src/fx/fx.service';
import { FixedClock } from 'test/support/fixed-clock';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

const RATES: FxRatesResponse = {
  base: 'USD',
  as_of: '2026-10-29T08:00:00Z',
  rates: { EUR: '0.9231', GBP: '0.7712', JPY: '152.10', ILS: '3.71' },
};

describe('FxService', () => {
  let clock: FixedClock;
  let latest: jest.Mock<Promise<FxRatesResponse>, [string]>;
  let inserted: FxQuoteEntity[];
  let quotes: FxQuoteRepository;

  const config = stub<ApiConfig>({ money: { fxProviderUrl: 'http://sim-fx:3200', fxCheckoutMarkupBps: 200 } });
  const ids = stub<IdFactory>({ opaque: (prefix: string) => `${prefix}01JBFX${inserted.length.toString().padStart(20, '0')}` });

  function service(provider: FxRatesClient | null = stub<FxRatesClient>({ latest })): FxService {
    return new FxService(quotes, ids, config, clock, new NoopLogger(), provider);
  }

  beforeEach(() => {
    clock = new FixedClock('2026-10-29T09:00:00.000Z');
    latest = jest.fn().mockResolvedValue(RATES);
    inserted = [];
    quotes = stub<FxQuoteRepository>({
      insertQuote: jest.fn(async (row: FxQuoteEntity) => {
        inserted.push(row);
        return row;
      }),
      findReusable: jest.fn(async () => null),
      findById: jest.fn(async (id: string) => inserted.find((row) => row.id === id) ?? null),
    });
  });

  it('crosses provider rates through the USD base', async () => {
    expect(await service().midRate('USD', 'EUR')).toEqual({ mid: '0.9231', asOf: new Date('2026-10-29T08:00:00Z') });
    expect((await service().midRate('EUR', 'GBP'))?.mid).toBe('0.8354457805');
  });

  it('prices a quote at mid plus the checkout markup, valid for 30 minutes', async () => {
    const quote = await service().quoteForSession('cs_1', 'USD', 'EUR');

    expect(quote).toMatchObject({
      fromCurrency: 'USD',
      toCurrency: 'EUR',
      midRate: '0.9231',
      markupBps: 200,
      rate: '0.941562',
      checkoutSessionId: 'cs_1',
    });
    expect(quote?.expiresAt.toISOString()).toBe('2026-10-29T09:30:00.000Z');
  });

  it('reuses a session quote that still has time left instead of pricing a new one', async () => {
    const existing = new FxQuoteEntity();
    existing.id = 'fxq_existing';
    quotes.findReusable = jest.fn(async () => existing);

    expect(await service().quoteForSession('cs_1', 'USD', 'EUR')).toBe(existing);
    expect(latest).not.toHaveBeenCalled();
  });

  it('caches rates for a minute and refetches after', async () => {
    const fx = service();
    await fx.midRate('USD', 'EUR');
    await fx.midRate('USD', 'JPY');
    expect(latest).toHaveBeenCalledTimes(1);

    clock.advanceMs(RATE_CACHE_MS);
    await fx.midRate('USD', 'EUR');
    expect(latest).toHaveBeenCalledTimes(2);
  });

  it('fails closed: no provider answer, no rate, no quote', async () => {
    latest.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const fx = service();

    expect(await fx.midRate('USD', 'EUR')).toBeNull();
    expect(await fx.quoteForSession('cs_1', 'USD', 'EUR')).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  it('fails closed without a provider configured', async () => {
    expect(await service(null).quoteForSession('cs_1', 'USD', 'EUR')).toBeNull();
  });

  it('ignores a malformed rate rather than pricing with it', async () => {
    latest.mockResolvedValue({ ...RATES, rates: { EUR: 'abc', JPY: '-3' } });
    const fx = service();
    expect(await fx.midRate('USD', 'EUR')).toBeNull();
    expect(await fx.midRate('USD', 'JPY')).toBeNull();
  });

  describe('requireSpendableQuote', () => {
    it('accepts the session’s own live quote for the pair', async () => {
      const fx = service();
      const quote = await fx.quoteForSession('cs_1', 'USD', 'EUR');
      await expect(fx.requireSpendableQuote(quote?.id ?? '', 'cs_1', 'USD', 'EUR')).resolves.toBe(quote);
    });

    it('refuses another session’s quote, another pair, or an expired one', async () => {
      const fx = service();
      const quote = await fx.quoteForSession('cs_1', 'USD', 'EUR');
      const id = quote?.id ?? '';

      await expect(fx.requireSpendableQuote(id, 'cs_2', 'USD', 'EUR')).rejects.toBeInstanceOf(ValidationException);
      await expect(fx.requireSpendableQuote(id, 'cs_1', 'USD', 'GBP')).rejects.toBeInstanceOf(ValidationException);
      clock.advanceMinutes(31);
      await expect(fx.requireSpendableQuote(id, 'cs_1', 'USD', 'EUR')).rejects.toBeInstanceOf(ValidationException);
    });
  });
});
