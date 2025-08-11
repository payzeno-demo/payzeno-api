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

export interface BreakerSnapshot {
  name: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  successes: number;
  rejects: number;
}

function isBreakerOpenError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message === 'Breaker is open' || (err as { code?: string }).code === 'EOPENBREAKER';
  }
  return false;
}
