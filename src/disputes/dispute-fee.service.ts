/**
 * DisputeFeeService — the chargeback fee lookup.
 *
 * `fee_minor` is not 1500. 1500 JPY is about ten dollars and 1500 USD cents is fifteen, so a
 * currency-blind constant is wrong twice over, and the fee is an acquirer contract term that
 * changes on a date. It comes from `dispute_fee_schedule (acquirer, currency, effective_from)`,
 * newest effective row that is not in the future.
 *
 * The fallback table below exists for exactly one situation: a dispute arriving for a currency
 * finance has not yet priced. It is logged at WARN every time it is used, and the runbook says
 * to add the row rather than to widen the fallback.
 *
 * FIXME: fee lookup should be cached. Every dispute webhook does a round trip for a table with
 * eleven rows that changes twice a year.
 */

import { Injectable } from '@nestjs/common';
import { DataSource, LessThanOrEqual } from 'typeorm';
import type { Acquirer, CurrencyCode, MinorUnits } from '@payzeno/contracts';

import { Inject } from '@nestjs/common';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { DisputeFeeScheduleEntity } from './dispute.entity';

/** Mirrors `app/domain/fees.py::DEFAULT_DISPUTE_FEE_BY_CURRENCY` on the ledger side. */
export const DEFAULT_DISPUTE_FEE_BY_CURRENCY: Readonly<Record<string, number>> = {
  USD: 1_500,
  EUR: 1_400,
  GBP: 1_200,
  JPY: 2_000,
};

const FALLBACK_FEE_MINOR = 1_500;

@Injectable()
export class DisputeFeeService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * The fee this dispute costs the merchant, in minor units of the dispute's currency.
   * Called once per dispute, at creation, and stored — a later schedule change must not
   * retroactively reprice a dispute the merchant has already been billed for.
   */
  async feeFor(acquirer: Acquirer, currency: CurrencyCode): Promise<MinorUnits> {
    const today = this.clock.now().toISOString().slice(0, 10);

    const row = await this.dataSource.getRepository(DisputeFeeScheduleEntity).findOne({
      where: { acquirer, currency, effective_from: LessThanOrEqual(today) },
      order: { effective_from: 'DESC' },
    });

    if (row) {
      return Number(row.fee_minor);
    }

    return this.fallbackFee(acquirer, currency);
  }

  private fallbackFee(acquirer: Acquirer, currency: CurrencyCode): MinorUnits {
    const fallback = DEFAULT_DISPUTE_FEE_BY_CURRENCY[currency];

    this.logger.warn('dispute_fee_schedule_miss', {
      acquirer,
      currency,
      used_minor: fallback ?? FALLBACK_FEE_MINOR,
      from_table: false,
    });

    return fallback ?? FALLBACK_FEE_MINOR;
  }

  /**
   * The whole schedule for one acquirer, for the console's pricing page and for the finance
   * runbook's "what will this cost" question. Effective-dated rows in the future are included
   * deliberately: the point of the page is to show the change before it lands.
   */
  scheduleFor(acquirer: Acquirer): Promise<DisputeFeeScheduleEntity[]> {
    return this.dataSource.getRepository(DisputeFeeScheduleEntity).find({
      where: { acquirer },
      order: { currency: 'ASC', effective_from: 'DESC' },
    });
  }
}
