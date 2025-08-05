/**
 * ConfigModule — the bottom of the dependency graph. Imports nothing.
 *
 * Deliberately not `@Global()`: every module that needs config imports this one, so the
 * IMPORTS edges are real and a reviewer can see who reads what. Same argument as CommonModule.
 */
import { Module, type DynamicModule } from '@nestjs/common';

import { API_CONFIG, type ApiConfig } from './api-config.type';
import { createKmsClient, createSnsClient, createSqsClient, KMS_CLIENT, SNS_CLIENT, SQS_CLIENT } from './aws.config';
import { loadConfiguration } from './configuration';
import { createRedisClient, REDIS_CLIENT } from './redis.config';

@Module({})
export class ConfigModule {
  /**
   * `forRoot()` in the app; `forRoot(fixture)` in test/support/test-app.ts, which supplies a
   * fully-formed ApiConfig instead of touching process.env in a shared jest worker.
   */
  static forRoot(override?: ApiConfig): DynamicModule {
    const config = override ?? loadConfiguration();

    return {
      module: ConfigModule,
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: REDIS_CLIENT, useFactory: () => createRedisClient(config) },
        { provide: SNS_CLIENT, useFactory: () => createSnsClient(config) },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config) },
        { provide: KMS_CLIENT, useFactory: () => createKmsClient(config) },
      ],
      exports: [API_CONFIG, REDIS_CLIENT, SNS_CLIENT, SQS_CLIENT, KMS_CLIENT],
      global: false,
    };
  }
}

/** Re-exported so consumers can take the token and the module from one import. */
export { API_CONFIG, ApiConfig } from './api-config.type';
export type { ApiConfig as ApiConfigType } from './api-config.type';
