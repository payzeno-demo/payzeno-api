/**
 * One opossum circuit per upstream, held in a registry so the breaker state survives between
 * requests. A breaker constructed per call is a breaker that never opens — that mistake was
 * made once, in month 4, and cost payzeno-api a 40-minute outage riding a legacy-biller
 * outage that should have been a 502 in 30ms.
 *
 * Thresholds are api-surface.md §13's: 50% error rate over a 20-request rolling window, 30s
 * reset. `BillingLegacyClient` and `AcquirerHttpClient` are the two production users.
 */

import { Injectable, Logger } from '@nestjs/common';
import CircuitBreaker from 'opossum';

export interface BreakerOptions {
  /** Percentage of failures in the rolling window that opens the circuit. */
  errorThresholdPercentage: number;
  /** Minimum requests in the window before the percentage means anything. */
  volumeThreshold: number;
  /** How long the circuit stays open before a half-open probe. */
  resetTimeoutMs: number;
  /** Per-call timeout enforced by the breaker itself, on top of the transport's. */
  timeoutMs: number;
}

export const DEFAULT_BREAKER_OPTIONS: BreakerOptions = {
  errorThresholdPercentage: 50,
  volumeThreshold: 20,
  resetTimeoutMs: 30_000,
  timeoutMs: 15_000,
};

export interface BreakerSnapshot {
  name: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  rejects: number;
}

type Guarded<T> = () => Promise<T>;

@Injectable()
export class CircuitBreakerRegistry {
  private readonly logger = new Logger(CircuitBreakerRegistry.name);
  private readonly breakers = new Map<string, CircuitBreaker<[Guarded<unknown>], unknown>>();

  /**
   * Runs `fn` under the named circuit. When the circuit is open the call is not attempted and
   * `onOpen()` supplies the exception the caller wants surfaced — `LegacyBillingUnavailableException`
   * for the biller, `ProcessorUnavailableException` for an acquirer. The registry does not
   * pick that for you, because a generic 502 loses the code the console renders.
   */
  async run<T>(name: string, fn: Guarded<T>, onOpen: () => Error, options?: Partial<BreakerOptions>): Promise<T> {
    const breaker = this.breakerFor(name, options);
    if (breaker.opened) {
      throw onOpen();
    }
    try {
      return (await breaker.fire(fn as Guarded<unknown>)) as T;
    } catch (err) {
      if (isBreakerOpenError(err)) {
        throw onOpen();
      }
      throw err;
    }
  }

  snapshot(): BreakerSnapshot[] {
    return [...this.breakers.entries()].map(([name, breaker]) => ({
      name,
      state: breaker.opened ? 'open' : breaker.halfOpen ? 'half-open' : 'closed',
      failures: breaker.stats.failures,
      successes: breaker.stats.successes,
      rejects: breaker.stats.rejects,
    }));
  }

  isOpen(name: string): boolean {
    return this.breakers.get(name)?.opened ?? false;
  }

  /** Test and runbook seam — `docs/runbooks/payzeno-api.md` documents closing a stuck circuit. */
  reset(name: string): void {
    this.breakers.get(name)?.close();
  }

  private breakerFor(
    name: string,
    overrides?: Partial<BreakerOptions>,
  ): CircuitBreaker<[Guarded<unknown>], unknown> {
    const existing = this.breakers.get(name);
    if (existing) {
      return existing;
    }
    const opts = { ...DEFAULT_BREAKER_OPTIONS, ...(overrides ?? {}) };
    const breaker = new CircuitBreaker<[Guarded<unknown>], unknown>((fn: Guarded<unknown>) => fn(), {
      name,
      errorThresholdPercentage: opts.errorThresholdPercentage,
      volumeThreshold: opts.volumeThreshold,
      resetTimeout: opts.resetTimeoutMs,
      timeout: opts.timeoutMs,
    });
    breaker.on('open', () => this.logger.error(`circuit ${name} opened`));
    breaker.on('halfOpen', () => this.logger.warn(`circuit ${name} half-open, probing`));
    breaker.on('close', () => this.logger.log(`circuit ${name} closed`));
    this.breakers.set(name, breaker);
    return breaker;
  }
}

function isBreakerOpenError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message === 'Breaker is open' || (err as { code?: string }).code === 'EOPENBREAKER';
  }
  return false;
}
