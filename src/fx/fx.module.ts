/**
 * FxModule — RFC platform-v2 §7: provider rates, checkout quotes, conversion.
 *
 * `FxRatesClient` is only built when `FX_PROVIDER_URL` is set. Without it `FxService` has no
 * provider and every rate lookup answers "none" — adaptive pricing switched off, fail closed.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiModule } from '../api/api.module';
import { DEFAULT_CLIENT_OPTIONS } from '../api/client';
import { NoRetryPolicy } from '../api/retry.policy';
import { HTTP_TRANSPORT, type HttpTransport } from '../api/transport.interface';
import { CommonModule } from '../common/common.module';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';

import { FxQuoteEntity } from './fx-quote.entity';
import { FxQuoteRepository } from './fx-quote.repository';
import { FxRatesClient } from './fx-rates.client';
import { FxService } from './fx.service';

@Module({
  imports: [CommonModule, ApiModule, TypeOrmModule.forFeature([FxQuoteEntity])],
  providers: [
    FxService,
    FxQuoteRepository,
    {
      provide: FxRatesClient,
      inject: [API_CONFIG, HTTP_TRANSPORT, PAYZENO_LOGGER],
      useFactory: (config: ApiConfig, transport: HttpTransport, logger: PayzenoLogger): FxRatesClient | null =>
        config.money.fxProviderUrl
          ? new FxRatesClient(
              config.money.fxProviderUrl,
              transport,
              // A checkout page load is waiting on this; a slow vendor is a missing option.
              { ...DEFAULT_CLIENT_OPTIONS, connectTimeoutMs: 1_000, readTimeoutMs: 2_000, retries: 0, userAgent: 'payzeno-api/fx' },
              new NoRetryPolicy(),
              logger,
            )
          : null,
    },
  ],
  exports: [FxService],
})
export class FxModule {}
