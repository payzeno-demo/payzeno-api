/**
 * The acquirer port. Frozen in interfaces.md §2.2.
 *
 * Three concretes are wired in production code: `WorldflowAdapter`, `NordpayAdapter` and
 * `SandboxProcessorAdapter` (reached by `sk_test_` keys — production code, not a fixture).
 * `ProcessorRouter.select(merchant, currency)` picks one per call.
 */

import type { Acquirer } from '@payzeno/contracts';

import type {
  AuthorizeRequest,
  AuthorizeResult,
  CaptureRequest,
  CaptureResult,
  ProcessorRefundRequest,
  ProcessorRefundResult,
  ProcessorWebhookEvent,
  VoidRequest,
  VoidResult,
} from './processor.types';

export interface ProcessorAdapter {
  readonly acquirer: Acquirer;
  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;
  capture(req: CaptureRequest): Promise<CaptureResult>;
  void(req: VoidRequest): Promise<VoidResult>;
  refund(req: ProcessorRefundRequest): Promise<ProcessorRefundResult>;
  parseWebhook(raw: Buffer, signature: string): ProcessorWebhookEvent;
  healthCheck(): Promise<boolean>;
}

/** Multi-provider injection token; `ProcessorRouter` receives every registered adapter. */
export const PROCESSOR_ADAPTERS = Symbol('PROCESSOR_ADAPTERS');

/**
 * Not every adapter serves every currency. Nordpay is the EEA acquirer and holds the SEPA/UK
 * scheme memberships; Worldflow is the default and the only one with USD/JPY interchange
 * pricing. `ProcessorRouter` reads this, `docs/adr/0006-acquirer-routing.md` explains it.
 */
export const SUPPORTED_CURRENCIES_BY_ACQUIRER: Readonly<Record<Acquirer, ReadonlyArray<string>>> = {
  worldflow: ['USD', 'EUR', 'GBP', 'ILS', 'JPY'],
  nordpay: ['EUR', 'GBP'],
};

export function adapterSupports(adapter: ProcessorAdapter, currency: string): boolean {
  return SUPPORTED_CURRENCIES_BY_ACQUIRER[adapter.acquirer].includes(currency);
}
