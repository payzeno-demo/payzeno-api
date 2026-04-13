/**
 * The dashboard's volume chart, as raw SQL.
 *
 * dhotfix approved this once, under protest, and asked for the comment to say why:
 * `date_trunc` over a parameterised interval cannot be expressed through the query builder
 * without either a `CASE` over every bucket or a second round trip, and the console renders
 * this on every dashboard load. The interval and the aggregate column are therefore
 * interpolated — but ONLY after being resolved against a frozen map, never from user input.
 * `TIMESERIES_INTERVALS` is the vocabulary; anything not in it throws before it reaches a
 * template string. Every value stays a bind parameter.
 *
 * TODO(PAY-1994): move this behind a materialised view once the 30d window starts hurting.
 * It has been fine for a year at our volume.
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type {
  CurrencyCode,
  MerchantId,
  TimeseriesInterval,
  TimeseriesPoint,
} from '@payzeno/contracts';

/** The only strings this file is allowed to interpolate. */
const BUCKET_SQL: Record<TimeseriesInterval, string> = {
  hour: "date_trunc('hour', c.created_at)",
  day: "date_trunc('day', c.created_at)",
};

/** Which money column each series sums. Same rule: resolved, never taken from the request. */
const SERIES_SQL = {
  gross: 'coalesce(sum(c.captured_amount_minor), 0)',
  refunded: 'coalesce(sum(c.refunded_amount_minor), 0)',
  net: 'coalesce(sum(c.captured_amount_minor - c.refunded_amount_minor), 0)',
} as const;

export type VolumeSeries = keyof typeof SERIES_SQL;

export interface VolumeQueryInput {
  merchantId: MerchantId;
  currency: CurrencyCode;
  livemode: boolean;
  interval: TimeseriesInterval;
  from: Date;
  to: Date;
  series: VolumeSeries;
}

interface RawBucket {
  bucket_start: Date;
  amount_minor: string;
  count: string;
}

@Injectable()
export class VolumeTimeseriesQuery {
  constructor(private readonly dataSource: DataSource) {}

  /**
   * Buckets of captured volume over `ix_charge_merchant_created`. Only charges that reached
   * a terminal money state count — an `authorized` charge is not volume, it is a promise.
   */
  async run(input: VolumeQueryInput): Promise<TimeseriesPoint[]> {
    const bucket = resolveBucket(input.interval);
    const amount = resolveSeries(input.series);

    const rows: RawBucket[] = await this.dataSource.query(
      `select ${bucket} as bucket_start,
              ${amount} as amount_minor,
              count(*) as count
         from charge c
        where c.merchant_id = $1
          and c.livemode = $2
          and c.currency = $3
          and c.created_at >= $4
          and c.created_at < $5
          and c.status in ('captured', 'settled', 'partially_refunded', 'refunded')
        group by 1
        order by 1 asc`,
      [input.merchantId, input.livemode, input.currency, input.from, input.to],
    );

    return rows.map(toPoint);
  }

  /**
   * Counts for the summary card. One pass over the same index, because two round trips for
   * numbers that render side by side is two chances to disagree.
   */
  async counts(
    merchantId: MerchantId,
    currency: CurrencyCode,
    livemode: boolean,
    from: Date,
    to: Date,
  ): Promise<{
    succeeded: number;
    failed: number;
    gross_minor: number;
    refunded_minor: number;
  }> {
    const rows: Array<{
      succeeded: string;
      failed: string;
      gross_minor: string;
      refunded_minor: string;
    }> = await this.dataSource.query(
      `select
         count(*) filter (where c.status in ('captured','settled','partially_refunded','refunded')) as succeeded,
         count(*) filter (where c.status = 'failed') as failed,
         coalesce(sum(c.captured_amount_minor), 0) as gross_minor,
         coalesce(sum(c.refunded_amount_minor), 0) as refunded_minor
       from charge c
      where c.merchant_id = $1
        and c.livemode = $2
        and c.currency = $3
        and c.created_at >= $4
        and c.created_at < $5`,
      [merchantId, livemode, currency, from, to],
    );

    const row = rows[0];
    return {
      succeeded: Number(row?.succeeded ?? 0),
      failed: Number(row?.failed ?? 0),
      gross_minor: Number(row?.gross_minor ?? 0),
      refunded_minor: Number(row?.refunded_minor ?? 0),
    };
  }

  /** Disputes opened in the window. Rides `ix_dispute_merchant_status`. */
  async disputeCount(
    merchantId: MerchantId,
    livemode: boolean,
    from: Date,
    to: Date,
  ): Promise<number> {
    const rows: Array<{ count: string }> = await this.dataSource.query(
      `select count(*) as count
         from dispute d
        where d.merchant_id = $1
          and d.livemode = $2
          and d.created_at >= $3
          and d.created_at < $4`,
      [merchantId, livemode, from, to],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

function resolveBucket(interval: TimeseriesInterval): string {
  const sql = BUCKET_SQL[interval];
  if (!sql) {
    throw new Error(`unsupported timeseries interval "${interval}"`);
  }
  return sql;
}

function resolveSeries(series: VolumeSeries): string {
  const sql = SERIES_SQL[series];
  if (!sql) {
    throw new Error(`unsupported volume series "${series}"`);
  }
  return sql;
}

function toPoint(row: RawBucket): TimeseriesPoint {
  return {
    bucket_start: new Date(row.bucket_start).toISOString(),
    amount_minor: Number(row.amount_minor),
    count: Number(row.count),
  };
}
