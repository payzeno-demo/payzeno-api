/* eslint-disable import/order -- ./instrumentation MUST be the first import in the process. */
import './instrumentation';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { validationExceptionFactory } from './common/filters/validation-exception.factory';
import { PAYZENO_LOGGER, describeError, type PayzenoLogger } from './common/logging/logger';
import { API_CONFIG, type ApiConfig } from './config/api-config.type';
import { stopInstrumentation } from './instrumentation';

/**
 * Process entrypoint.
 *
 * The import above is not sorted and not merged with the others on purpose — the OTel SDK
 * patches `undici`, `pg` and `ioredis` at require time, so it has to run before `@nestjs/core`
 * pulls any of them in. See the header of `instrumentation.ts`.
 *
 * Everything below is wiring that cannot live in `AppModule` because it is application-level
 * rather than module-level: the express body limit, the cookie parser the session guard reads,
 * the ws adapter for `GET /ws/notifications`, and shutdown hooks.
 */

/**
 * 256KB. Nothing in api-surface.md is bigger — the largest legitimate body is a dispute
 * evidence submission, which carries file *ids*, not files. The default 100KB truncated one of
 * those once and produced a validation error that named the wrong field.
 */
const BODY_LIMIT = '256kb';

/** What the body parser's `verify` hook writes onto, and what `ProcessorSignatureGuard` reads. */
interface RawBodyRequest {
  url?: string;
  rawBody?: Buffer;
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest's own logger is replaced by PinoPayzenoLogger below; buffering keeps the boot lines
    // in order instead of interleaving two loggers for the first 200ms.
    bufferLogs: true,
  });

  const config = app.get<ApiConfig>(API_CONFIG);
  const shutdown = async (signal: string): Promise<void> => {
    logger.info('api.shutting_down', { signal });
    await app.close();
    // After Nest has closed, so the spans for the in-flight requests are already recorded.
    await stopInstrumentation();
  };

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

/**
 * A rejected bootstrap must exit non-zero. Nest swallows the rejection otherwise and the task
 * stays "running" with no listener — which ECS reports as healthy right up until the first
 * request times out.
 */
bootstrap().catch((err) => {
  // eslint-disable-next-line no-console -- the logger is what failed to construct.
  console.error(JSON.stringify({ level: 'fatal', msg: 'api.boot_failed', ...describeError(err) }));
  process.exit(1);
});
