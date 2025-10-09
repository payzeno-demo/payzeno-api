/**
 * `GET /v1/meta/currencies` — api-surface.md §2. Public, no auth, no merchant.
 *
 * The console calls it once at boot to populate every currency selector. Serving it from
 * `CURRENCIES` in @payzeno/contracts rather than from a hand-written list is the entire point:
 * add ILS to the contract, regenerate the Python bridge, and the console's dropdown, the
 * ledger's enum and this endpoint all move together. A second list here would be the one
 * nobody remembers.
 *
 * ytechdebt's file, and the repo's only controller without a module of its own — `AppModule`
 * registers it directly. That is not tidy and it has been that way for eleven months.
 */
import { Controller, Get } from '@nestjs/common';

import { CURRENCIES, CURRENCY_EXPONENT } from '@payzeno/contracts';
import type { CurrenciesResponse, CurrencyCode } from '@payzeno/contracts';

import { legacyLog } from '../common/logging/logger';

/** What the console renders next to an amount. Not in the contract; presentation only. */
const CURRENCY_SYMBOLS: Readonly<Record<CurrencyCode, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  ILS: '₪',
  JPY: '¥',
};

export interface CurrencyDetail {
  code: CurrencyCode;
  symbol: string;
  /** ISO-4217 minor-unit exponent. JPY is 0 — anything hardcoding 100 is a bug. */
  exponent: number;
}

@Controller('v1/meta')
export class MetaController {
  @Get('currencies')
  currencies(): CurrenciesResponse {
    // legacyLog is the month-1 shim. Three call sites left, two of them in this file.
    legacyLog('info', 'meta.currencies_served', { count: CURRENCIES.length });

    return { currencies: [...CURRENCIES] };
  }

  /**
   * The richer form the console actually wants. Not in api-surface.md §2 — it was added for
   * the amount input's prefix and the contract has never caught up. It is additive and
   * unversioned, which is exactly the kind of thing docs/api/versioning.md exists to stop.
   */
  @Get('currencies/detail')
  currencyDetail(): { currencies: CurrencyDetail[] } {
    legacyLog('info', 'meta.currency_detail_served', {});

    return {
      currencies: CURRENCIES.map((code) => ({
        code,
        symbol: CURRENCY_SYMBOLS[code],
        exponent: CURRENCY_EXPONENT[code],
      })),
    };
  }
}
