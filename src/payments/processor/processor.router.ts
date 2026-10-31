/**
 * L4 gateway service. Picks the acquirer for a call.
 *
 * Frame 5 of the capture chain. The rules, in order, and they are ordered on purpose:
 *
 *   1. test-mode principal            → SandboxProcessorAdapter (no live acquirer, ever)
 *   2. currency the default cannot do → the acquirer that can (Nordpay holds SEPA/UK schemes)
 *   3. otherwise                      → PROCESSOR_DEFAULT_ACQUIRER
 *
 * There is deliberately no health-based failover here. Re-routing an authorisation to a second
 * acquirer mid-outage produces two auths on the same card as often as it rescues one, and the
 * scheme's duplicate-authorisation rules are not on our side. The breaker fails the call and
 * the merchant retries. `docs/adr/0006-acquirer-routing.md`.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Acquirer, CurrencyCode, Merchant } from '@payzeno/contracts';

import { LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { ProcessorUnavailableException } from '../../common/errors/upstream.exceptions';
import { adapterSupports, PROCESSOR_ADAPTERS, type ProcessorAdapter } from './processor.adapter';
import { SandboxProcessorAdapter } from './sandbox.adapter';

export interface RoutingContext {
  /** True for `sk_test_` principals and for any merchant still in `pending_review`. */
  livemode: boolean;
}

@Injectable()
export class ProcessorRouter {
  constructor(
    @Inject(PROCESSOR_ADAPTERS) private readonly adapters: ReadonlyArray<ProcessorAdapter>,
    private readonly sandbox: SandboxProcessorAdapter,
    @Inject(LOGGER) private readonly logger: PayzenoLogger,
    private readonly defaultAcquirer: Acquirer,
  ) {}

  select(merchant: Merchant, currency: CurrencyCode, ctx: RoutingContext = { livemode: true }): ProcessorAdapter {
    if (!ctx.livemode) {
      return this.sandbox;
    }

    const candidates = this.adapters.filter((adapter) => adapterSupports(adapter, currency));
    if (candidates.length === 0) {
      throw new ProcessorUnavailableException(
        this.defaultAcquirer,
        `no acquirer is configured for ${currency}`,
      );
    }

    const preferred = candidates.find((adapter) => adapter.acquirer === this.defaultAcquirer);
    const chosen = preferred ?? candidates[0];

    if (!preferred) {
      this.logger.info('acquirer_routed_off_default', {
        merchant_id: merchant.id,
        currency,
        chosen: chosen.acquirer,
        default: this.defaultAcquirer,
      });
    }
    return chosen;
  }

  /** Used when a later call must go back to the acquirer that holds the authorisation. */
  forAcquirer(acquirer: Acquirer, ctx: RoutingContext = { livemode: true }): ProcessorAdapter {
    if (!ctx.livemode) {
      return this.sandbox;
    }
    const adapter = this.adapters.find((candidate) => candidate.acquirer === acquirer);
    if (!adapter) {
      throw new ProcessorUnavailableException(acquirer, 'not configured');
    }
    return adapter;
  }

  /** `HealthService` reports one line per acquirer on `/readyz`. */
  async health(): Promise<Record<Acquirer, boolean>> {
    const results = await Promise.all(
      this.adapters.map(async (adapter) => [adapter.acquirer, await adapter.healthCheck()] as const),
    );
    return Object.fromEntries(results) as Record<Acquirer, boolean>;
  }
}
