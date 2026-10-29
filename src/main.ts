/* eslint-disable import/order -- ./instrumentation MUST be the first import in the process. */
import './instrumentation';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';
import { validationExceptionFactory } from './common/filters/validation-exception.factory';
import { keepsRawBody } from './common/middleware/raw-body';
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
 * 1MB, the same as nginx's `client_max_body_size`. Everything in api-surface.md fits in 256KB
 * except one route: `POST /v1/onboarding/documents` (RFC platform-v2 §3) carries a KYC document
 * as base64, up to 600KB decoded — about 820KB on the wire. The DTO caps that field, and every
 * other route's validation rejects oversized fields long before the body gets near this. The
 * default 100KB once truncated a dispute evidence submission and produced a validation error
 * that named the wrong field.
 */
const BODY_LIMIT = '1mb';

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
  const logger = app.get<PayzenoLogger>(PAYZENO_LOGGER);

  app.use(cookieParser());

  /**
   * The `verify` hook keeps the raw bytes on the request for the acquirer webhook routes, and
   * only for those. `ProcessorSignatureVerifier` HMACs the bytes as they arrived — verifying a
   * re-serialised copy of the parsed object means key ordering decides whether a webhook
   * authenticates, which is a silent downgrade to no verification at all.
   *
   * Scoped by path rather than applied globally: holding a Buffer copy of every request body
   * in memory for the whole request is a cost with no benefit on the other 60 routes.
   */
  app.useBodyParser('json', {
    limit: BODY_LIMIT,
    verify: (req: RawBodyRequest, _res: unknown, buf: Buffer) => {
      if (keepsRawBody(req.url)) {
        req.rawBody = Buffer.from(buf);
      }
    },
  });

  /**
   * `X-Forwarded-For` is set by nginx and by the ALB. Without this, `RateLimitGuard`'s IP
   * bucket keys on the load balancer's address and every merchant behind the same ingress
   * shares one bucket — which is to say, the rate limiter limits nothing.
   */
  app.set('trust proxy', true);

  /**
   * The `ws` adapter, for `GET /ws/notifications` (`NotificationsGateway`). socket.io is not
   * used: the console's `useNotificationStream()` is a plain `WebSocket`, and the socket.io
   * handshake would need a client library on the browser side to talk to.
   */
  app.useWebSocketAdapter(new WsAdapter(app));

  /**
   * The same ValidationPipe AppModule registers as APP_PIPE. Registering it here as well is
   * not redundant: the APP_PIPE provider does not apply to the WebSocket adapter's message
   * payloads, and `app.useGlobalPipes` does.
   */
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    }),
  );

  /**
   * Lets `onApplicationShutdown` run on SIGTERM — which is how ECS stops a task. Without it,
   * the SQS consumers keep long-polling into a process that is about to die and the messages
   * they claimed sit invisible until the visibility timeout expires.
   */
  app.enableShutdownHooks();

  /**
   * CORS is handled at the ingress for the console's origin, but the browser also talks
   * directly to this service in local development, where there is no nginx.
   */
  if (config.runtime.nodeEnv !== 'production') {
    app.enableCors({ origin: true, credentials: true });
  }

  await app.listen(config.runtime.port, '0.0.0.0');

  logger.info('api.started', {
    port: config.runtime.port,
    env: config.runtime.nodeEnv,
    version: config.runtime.serviceVersion,
    idempotency_backend: config.idempotency.backend,
  });

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
