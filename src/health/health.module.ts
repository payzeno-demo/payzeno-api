/**
 * HealthModule.
 *
 * Imports `CommonModule` and nothing else. That is the point: the readiness probe must be
 * answerable when every feature module in the process is unhappy, so it depends on the
 * `DataSource`, the redis client and `ApiConfig` — all of which come through CommonModule —
 * and on no service that could itself be the thing that is broken.
 *
 * In particular it does NOT import `LedgerModule`. `HealthService.pingLedger()` calls the
 * ledger with a plain undici request rather than through `LedgerHttpClient`, because the
 * shared client retries and trips a circuit breaker, and a probe must do neither
 * (api-surface.md §6.1). Importing LedgerModule here would put the temptation one autocomplete
 * away.
 *
 * apager owns this directory jointly with Platform — see CODEOWNERS.
 */
import { Module } from '@nestjs/common';

import { CommonModule } from '../common/common.module';

import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [CommonModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
