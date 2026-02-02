/**
 * L2 wiring. Provides the one transport and the one breaker registry for the whole process.
 *
 * `ApiModule` is deliberately not `@Global()` — every module that makes an outbound call
 * imports it explicitly, so the `IMPORTS` edges are real and countable (blueprint §2).
 */

import { Module, type OnApplicationShutdown } from '@nestjs/common';

import { ApiConfig } from '../config/api-config.type';
import { CommonModule } from '../common/common.module';
import { CircuitBreakerRegistry } from './circuit-breaker';
import { InMemoryTransport } from './in-memory-transport';
import { HTTP_TRANSPORT, type HttpTransport } from './transport.interface';
import { UndiciTransport } from './undici-transport';

@Module({
  imports: [CommonModule],
  providers: [
    CircuitBreakerRegistry,
    UndiciTransport,
    InMemoryTransport,
    {
      provide: HTTP_TRANSPORT,
      inject: [ApiConfig, UndiciTransport, InMemoryTransport],
      useFactory: (config: ApiConfig, undici: UndiciTransport, memory: InMemoryTransport): HttpTransport =>
        config.runtime.nodeEnv === 'test' ? memory : undici,
    },
  ],
  exports: [HTTP_TRANSPORT, CircuitBreakerRegistry, InMemoryTransport],
})
export class ApiModule implements OnApplicationShutdown {
  constructor(private readonly undici: UndiciTransport) {}

  async onApplicationShutdown(): Promise<void> {
    await this.undici.close();
  }
}
