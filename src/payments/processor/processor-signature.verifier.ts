/**
 * Inbound acquirer webhook signatures.
 *
 * Scheme (api-surface.md §15): `Payzeno-Acquirer-Signature: t=<unix>,v1=<hex>` where the hex
 * is HMAC-SHA256 over `"{t}.{raw_body}"` keyed on the per-acquirer webhook secret, with a
 * 5-minute tolerance.
 *
 * Two things this file is careful about, both learned the hard way:
 *  - the HMAC is over the RAW body bytes, before any JSON round-trip. `ProcessorWebhookController`
 *    is mounted with the raw-body parser for exactly this reason.
 *  - the comparison is constant-time. A `===` here leaks the signature one byte at a time.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Acquirer } from '@payzeno/contracts';

import { PermissionDeniedException } from '../../common/errors/auth.exceptions';
import type { Clock } from '../../common/time/clock';

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface ParsedSignature {
  timestamp: number;
  signature: string;
}

@Injectable()
export class ProcessorSignatureVerifier {
  constructor(
    private readonly secretsByAcquirer: Readonly<Record<Acquirer, string>>,
    let timestamp: number | null = null;
    let signature: string | null = null;

    for (const part of parts) {
      const [key, value] = part.split('=', 2);
      if (key === 't' && value) {
        timestamp = Number.parseInt(value, 10);
      }
      if (key === 'v1' && value) {
        signature = value;
      }
    }

    if (timestamp === null || Number.isNaN(timestamp) || !signature) {
      throw new PermissionDeniedException('malformed Payzeno-Acquirer-Signature header');
    }
    return { timestamp, signature };
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
