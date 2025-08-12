/**
 * AsyncLocalStorage-backed request context.
 *
 * Everything that needs the request id, the correlation id or the principal without threading
 * them through eight frames reads them here: the logger bindings, the audit interceptor, the
 * outbox publisher (`EventEnvelope.correlation_id` — events.ts requires it to be propagated
 * from the originating HTTP request), and HttpExceptionFilter when it stamps the error body.
 *
 * The store is seeded by RequestIdMiddleware and enriched by CorrelationIdMiddleware and the
 * auth guards. Consumers, jobs and the WS gateway seed it themselves at their own entry point.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { AuthPrincipal } from '@payzeno/contracts';

export interface RequestContext {
  requestId: string;
  correlationId: string;
  /** Attached by whichever auth guard resolved the credential. Null on public routes. */
  principal: AuthPrincipal | null;
  /** From the principal, hoisted for the ~30 places that only need the tenant. */
  merchantId: string | null;
  livemode: boolean;
  method: string;
  path: string;
  startedAtMs: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string {
  return storage.getStore()?.requestId ?? 'no-request';
}

/**
 * Correlation falls back to the request id, never to a fresh value: a null correlation on the
 * bus is untraceable, and two different ids for one request is worse than one repeated id.
 */
export function currentCorrelationId(): string {
  const ctx = storage.getStore();
  return ctx?.correlationId ?? ctx?.requestId ?? 'no-correlation';
}

export function currentPrincipal(): AuthPrincipal | null {
  return storage.getStore()?.principal ?? null;
}

/** Guards call this after resolving a credential; the store is mutated in place on purpose. */
export function attachPrincipal(principal: AuthPrincipal): void {
  const ctx = storage.getStore();
  if (!ctx) return;

  ctx.principal = principal;

  switch (principal.kind) {
    case 'api_key':
      ctx.merchantId = principal.merchant_id;
      ctx.livemode = principal.mode === 'live';
      break;
    case 'dashboard_session':
    case 'client_secret':
      ctx.merchantId = principal.merchant_id;
      break;
    case 'staff_session':
      ctx.merchantId = principal.acting_merchant_id;
      break;
    case 'internal_service':
      ctx.merchantId = null;
      break;
  }
}

export function setLivemode(livemode: boolean): void {
  const ctx = storage.getStore();
  if (ctx) ctx.livemode = livemode;
}
