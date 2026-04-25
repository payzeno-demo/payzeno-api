import type { IsoTimestamp } from '@payzeno/contracts';

/**
 * What one delivery attempt produced. Returned by every `WebhookDeliveryStrategy`; consumed
 * by `WebhookDeliveryJob`, which is the only thing allowed to turn it into a status change.
 */
export interface DeliveryResult {
  delivered: boolean;
  /** Null when the request never got a response — DNS, connect timeout, TLS failure. */
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
  /** Populated by the job, not by the strategy — the strategy has no retry budget. */
  nextAttemptAt: IsoTimestamp | null;
}

/**
 * The signing material handed to a strategy. Two entries during a rotation overlap: the
 * merchant may still be verifying against the old secret, so we send both signatures.
 */
export function isPermanentRejection(status: number | null): boolean {
  return status === 410;
}

export function formatSignatureHeader(timestamp: number, signatures: readonly string[]): string {
  return [`t=${timestamp}`, ...signatures.map((sig) => `v1=${sig}`)].join(',');
}
