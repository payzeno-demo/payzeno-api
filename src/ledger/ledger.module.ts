/**
 * The ledger seam. Imports `CommonModule` and `ApiModule` and nothing else — it must never
 * import a feature module, because every feature module imports it.
 *
 * `LedgerHttpClient` is constructed by a factory rather than by `@Injectable()` DI because it
 * needs the retry policy and the timeout block from `ApiConfig`, and those are per-upstream
 * values, not global ones.
 */

import { Module } from '@nestjs/common';

import { ApiModule } from '../api/api.module';
import { DEFAULT_CLIENT_OPTIONS } from '../api/client';
import { IdempotentRetryPolicy } from '../api/retry.policy';
import { HTTP_TRANSPORT, type HttpTransport } from '../api/transport.interface';
import { CommonModule } from '../common/common.module';
import { LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { ApiConfig } from '../config/api-config.type';
import { BalanceController } from './balance.controller';
import { BalanceService } from './balance.service';
import { LedgerHttpClient } from './ledger-http.client';
import { LedgerReadThroughService } from './ledger-read-through.service';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { SettlementsController } from './settlements.controller';

@Module({
  imports: [CommonModule, ApiModule],
  controllers: [BalanceController, PayoutsController, SettlementsController],
  providers: [
    {
      provide: LedgerHttpClient,
      inject: [ApiConfig, HTTP_TRANSPORT, LOGGER],
      useFactory: (config: ApiConfig, transport: HttpTransport, logger: PayzenoLogger): LedgerHttpClient =>
        new LedgerHttpClient(
          { baseUrl: config.ledger.baseUrl, internalSecret: config.ledger.internalApiSecret },
          transport,
          { ...DEFAULT_CLIENT_OPTIONS, connectTimeoutMs: 2_000, readTimeoutMs: 10_000, retries: 2, userAgent: 'payzeno-api/ledger' },
          new IdempotentRetryPolicy(3),
          logger,
        ),
    },
    LedgerReadThroughService,
    BalanceService,
    PayoutsService,
  ],
  exports: [LedgerHttpClient, LedgerReadThroughService, BalanceService, PayoutsService],
})
export class LedgerModule {}
