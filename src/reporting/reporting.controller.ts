/**
 * ReportingController — `GET /v1/reporting/{summary,volume,balance-history}`, api-surface §9.
 *
 * Session-authed only. There is no API-key route here on purpose: these are dashboard
 * aggregates shaped for a screen, not a stable machine-readable report, and we reserve the
 * right to change what "net volume" means when pricing changes.
 */
import { Controller, Get, Query, UseGuards, UseInterceptors } from '@nestjs/common';

import type {
  BalanceHistoryResponse,
  CurrencyCode,
  DashboardSummary,
  MerchantId,
  ReportingWindow,
  TimeseriesInterval,
  VolumeTimeseries,
  AuthPrincipal,
} from '@payzeno/contracts';

import { SessionGuard } from '../auth/guards/session.guard';
import { CurrentPrincipal, MerchantScoped, RateLimit } from '../common/decorators';
import { ValidationException } from '../common/errors/api.exception';
import { SerializerInterceptor } from '../common/interceptors/serializer.interceptor';

import { ReportingService } from './reporting.service';

const WINDOWS: readonly ReportingWindow[] = ['24h', '7d', '30d'];
const INTERVALS: readonly TimeseriesInterval[] = ['hour', 'day'];

@Controller('v1/reporting')
@MerchantScoped()
@UseGuards(SessionGuard)
@UseInterceptors(SerializerInterceptor)
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  /** The dashboard's headline card. Two ledger reads and one of ours. */
  @Get('summary')
  @RateLimit(120, 60)
  async summary(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query('window') window = '7d',
    @Query('currency') currency = 'USD',
  ): Promise<DashboardSummary> {
    return this.reporting.summary({
      merchantId: merchantOf(principal),
      currency: assertCurrency(currency),
      livemode: livemodeOf(principal),
      window: assertWindow(window),
    });
  }

  /** The volume chart. `from`/`to` are required — an unbounded scan is not a chart. */
  @Get('volume')
  @RateLimit(120, 60)
  async volume(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('interval') interval = 'day',
    @Query('currency') currency = 'USD',
  ): Promise<VolumeTimeseries> {
    return this.reporting.volume({
      merchantId: merchantOf(principal),
      currency: assertCurrency(currency),
      livemode: livemodeOf(principal),
      interval: assertInterval(interval),
      from: assertTimestamp('from', from),
      to: assertTimestamp('to', to),
    });
  }

  /** Straight read-through to the ledger; we own none of these numbers. */
  @Get('balance-history')
  @RateLimit(120, 60)
  async balanceHistory(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query('from') from: string,
    @Query('to') to: string,
    @Query('interval') interval = 'day',
    @Query('currency') currency = 'USD',
  ): Promise<BalanceHistoryResponse> {
    return this.reporting.balanceHistory(
      merchantOf(principal),
      assertCurrency(currency),
      assertTimestamp('from', from),
      assertTimestamp('to', to),
      assertInterval(interval),
    );
  }
}

/**
 * Query params are strings and the enums are frozen vocabularies, so they are checked here
 * rather than by a DTO — three primitives do not earn a class. Everything throws the same
 * `ValidationException` the pipe would have, so the 422 body is identical either way.
 */
function invalid(path: string, message: string): ValidationException {
  return new ValidationException('Validation failed', [
    { path, code: 'invalid_value', message },
  ]);
}

function assertWindow(value: string): ReportingWindow {
  if (!(WINDOWS as readonly string[]).includes(value)) {
    throw invalid('window', `must be one of ${WINDOWS.join(', ')}`);
  }
  return value as ReportingWindow;
}

function assertInterval(value: string): TimeseriesInterval {
  if (!(INTERVALS as readonly string[]).includes(value)) {
    throw invalid('interval', `must be one of ${INTERVALS.join(', ')}`);
  }
  return value as TimeseriesInterval;
}

function assertCurrency(value: string): CurrencyCode {
  if (!/^[A-Z]{3}$/.test(value)) {
    throw invalid('currency', 'must be a three-letter ISO 4217 code');
  }
  return value as CurrencyCode;
}

function assertTimestamp(field: string, value: string): string {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw invalid(field, 'must be an RFC 3339 timestamp');
  }
  return value;
}

function merchantOf(principal: AuthPrincipal): MerchantId {
  if (principal.kind === 'dashboard_session') {
    return principal.merchant_id;
  }
  if (principal.kind === 'staff_session' && principal.acting_merchant_id) {
    return principal.acting_merchant_id;
  }
  throw invalid('merchant_id', 'no merchant in scope for this principal');
}

function livemodeOf(principal: AuthPrincipal): boolean {
  return principal.kind !== 'api_key' || principal.mode === 'live';
}
