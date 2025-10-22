/**
 * ReportingService — everything the console dashboard renders above the fold.
 *
 * Two sources, deliberately: charge/dispute counts come from our own tables (they are ours
 * and they are indexed for it), balances and the next payout come from the ledger, which owns
 * the money. Nothing here recomputes a balance from charges — that is how two screens end up
 * disagreeing about the same number.
 */
import { Inject, Injectable } from '@nestjs/common';

import type {
  Balance,
  BalanceHistoryResponse,
  CurrencyCode,
  DashboardSummary,
  MerchantId,
  Payout,
  ReportingWindow,
  TimeseriesInterval,
  VolumeTimeseries,
} from '@payzeno/contracts';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { LedgerReadThroughService } from '../ledger/ledger-read-through.service';

import { VolumeTimeseriesQuery, type VolumeSeries } from './volume-timeseries.query';

const WINDOW_HOURS: Record<ReportingWindow, number> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

export interface SummaryQuery {
  merchantId: MerchantId;
  currency: CurrencyCode;
  livemode: boolean;
  window: ReportingWindow;
}

export interface VolumeQuery {
  merchantId: MerchantId;
  currency: CurrencyCode;
  livemode: boolean;
  interval: TimeseriesInterval;
  from: string;
  to: string;
  series?: VolumeSeries;
}

@Injectable()
export class ReportingService {
  constructor(
    private readonly volumes: VolumeTimeseriesQuery,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * `GET /v1/reporting/summary`.
   *
   * Three reads: our own counts, the ledger balance, and the next scheduled payout. The
   * payout read is `?status=scheduled&limit=1` — the console only renders the next one and a
   * merchant with a daily schedule has three hundred of them.
   */
  async summary(query: SummaryQuery): Promise<DashboardSummary> {
    const to = this.clock.now();
    const from = new Date(to.getTime() - WINDOW_HOURS[query.window] * 3_600_000);

    const [counts, disputeCount, balance, nextPayout] = await Promise.all([
      this.volumes.counts(query.merchantId, query.currency, query.livemode, from, to),
      this.volumes.disputeCount(query.merchantId, query.livemode, from, to),
      this.ledger.getBalance(query.merchantId, query.currency, query.livemode),
      this.nextScheduledPayout(query.merchantId),
    ]);

    return {
      object: 'dashboard_summary',
      merchant_id: query.merchantId,
      currency: query.currency,
      window: query.window,
      gross_volume_minor: counts.gross_minor,
      net_volume_minor: counts.gross_minor - counts.refunded_minor,
      refunded_minor: counts.refunded_minor,
      dispute_count: disputeCount,
      succeeded_count: counts.succeeded,
      failed_count: counts.failed,
      next_payout: nextPayout,
      balance,
    };
  }

  /** `GET /v1/reporting/volume`. */
  async volume(query: VolumeQuery): Promise<VolumeTimeseries> {
    const points = await this.volumes.run({
      merchantId: query.merchantId,
      currency: query.currency,
      livemode: query.livemode,
      interval: query.interval,
      from,
      to,
      series: query.series ?? 'gross',
    });

    // TODO(PAY-2011): the console asks for 30 days at hourly resolution on first paint and
    // then throws 700 of the 720 points away. Cap it here once the chart stops doing that.
    if (points.length > 800) {
      this.logger.warn('reporting.volume_oversized', {
        merchant_id: query.merchantId,
        interval: query.interval,
        points: points.length,
      });
    }

    return {
      object: 'volume_timeseries',
      merchant_id: query.merchantId,
      currency: query.currency,
      interval: query.interval,
      points,
    };
  }

  /**
   * `GET /v1/reporting/balance-history` — straight read-through. We do not cache it: the
   * ledger's own `merchant_balance_cache` is already the cache, and a second one would be a
   * second thing to invalidate.
   */
  async balanceHistory(
    merchantId: MerchantId,
    currency: CurrencyCode,
    from: string,
    to: string,
    interval: TimeseriesInterval,
  ): Promise<BalanceHistoryResponse> {
    return this.ledger.getBalanceHistory(merchantId, {
      currency,
      from,
      to,
      interval,
    });
  }

  /** Convenience for the summary card; also used by the payouts page's header. */
  async currentBalance(
    merchantId: MerchantId,
    currency: CurrencyCode,
    livemode: boolean,
  ): Promise<Balance> {
    return this.ledger.getBalance(merchantId, currency, livemode);
  }

  private async nextScheduledPayout(merchantId: MerchantId): Promise<Payout | null> {
  }
}
