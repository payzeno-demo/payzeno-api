/**
 * OpenTelemetry bootstrap. This file is imported FIRST in `main.ts`, before `@nestjs/core`,
 * before `typeorm`, before `undici` — before anything.
 *
 * That ordering is not a style preference. The Node SDK works by monkey-patching module
 * exports at require time: `undici`'s `request`, `pg`'s `Client.prototype.query`,
 * `ioredis`'s command pipeline. A module that was already required holds a reference to the
 * original function and will never emit a span. We learned that the boring way in month 3,
 * when `AcquirerHttpClient` was the only client in the repo with no traces and everyone
 * assumed the acquirer was the problem.
 *
 * `main.ts` therefore starts with a bare `import './instrumentation';` on line one and an
 * eslint-disable for import/order above it. Do not sort that import.
 *
 * The endpoint comes from `OTEL_EXPORTER_OTLP_ENDPOINT` through `loadConfiguration()` — the
 * repo's one env reader — and an empty endpoint disables the exporter rather than failing
 * boot. A tracing collector being down must never stop the API from taking payments.
 *
 * dhotfix's file. docs/runbooks/payzeno-api.md § "traces are missing".
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import { loadConfiguration } from './config/configuration';

/** Routes that would otherwise produce one span per second, forever. */
const IGNORED_SERVER_PATHS = ['/healthz', '/readyz', '/metrics'];

let sdk: NodeSDK | null = null;

/**
 * Starts the SDK. Idempotent — `main.ts` calls it via the module side effect and the e2e
 * global setup calls it explicitly, and starting twice throws inside the SDK.
 */
export function startInstrumentation(): NodeSDK | null {
  if (sdk) return sdk;

  const config = loadConfiguration();
  const { runtime } = config;

  if (runtime.logLevel === 'debug') {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  }

  const resource = new Resource({
    [SEMRESATTRS_SERVICE_NAME]: runtime.serviceName,
    [SEMRESATTRS_SERVICE_VERSION]: runtime.serviceVersion,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: runtime.nodeEnv,
  });

  /**
   * No endpoint means no collector — dev, CI, and the `jobs --dry-run` path. The SDK still
   * starts and every `startSpan()` call site stays valid; the spans simply go nowhere rather
   * than queueing against a socket that will never connect.
   */
  const spanProcessor: SpanProcessor | undefined = runtime.otelExporterOtlpEndpoint
    ? new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${runtime.otelExporterOtlpEndpoint}/v1/traces` }),
      )
    : undefined;

  sdk = new NodeSDK({
    resource,
    ...(spanProcessor ? { spanProcessor } : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (request) =>
            IGNORED_SERVER_PATHS.some((path) => (request.url ?? '').startsWith(path)),
        },
        // The filesystem instrumentation produces roughly nine spans per request and answers
        // no question anyone has ever asked in an incident.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  return sdk;
}

/**
 * Flushes and stops. `main.ts` awaits this after `app.close()`, so the spans for the request
 * that triggered a rolling restart actually leave the process.
 */
export async function stopInstrumentation(): Promise<void> {
  if (!sdk) return;
  const stopping = sdk;
  sdk = null;
  await stopping.shutdown();
}

startInstrumentation();
