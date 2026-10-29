/**
 * The one id generator. `<prefix>_<26-char ULID>`, monotonic within a process so ids sort by
 * creation order — which is what makes `ORDER BY id` a legal cursor tiebreaker in
 * PayzenoRepository.paginateCursor.
 */
import { Injectable } from '@nestjs/common';
import { monotonicFactory, ulid } from 'ulid';

import { API_ID_PREFIXES, isPayzenoId, type ApiIdPrefix } from './id.prefix';

const monotonic = monotonicFactory();

@Injectable()
export class IdFactory {
  private readonly generate: (seedTime?: number) => string;

  constructor(generator: (seedTime?: number) => string = monotonic) {
    this.generate = generator;
  }

  private mint(prefix: ApiIdPrefix, at?: number): string {
    return `${prefix}${this.generate(at)}`;
  }

  merchantId(at?: number): string {
    return this.mint(API_ID_PREFIXES.merchant, at);
  }

  userId(at?: number): string {
    return this.mint(API_ID_PREFIXES.user, at);
  }

  apiKeyId(at?: number): string {
    return this.mint(API_ID_PREFIXES.apiKey, at);
  }

  bankAccountId(at?: number): string {
    return this.mint(API_ID_PREFIXES.bankAccount, at);
  }

  paymentIntentId(at?: number): string {
    return this.mint(API_ID_PREFIXES.paymentIntent, at);
  }

  chargeId(at?: number): string {
    return this.mint(API_ID_PREFIXES.charge, at);
  }

  refundId(at?: number): string {
    return this.mint(API_ID_PREFIXES.refund, at);
  }

  disputeId(at?: number): string {
    return this.mint(API_ID_PREFIXES.dispute, at);
  }

  /** Also used for `event_outbox.id` and `audit_log.id` — same `evt_`/opaque shape. */
  webhookEventId(at?: number): string {
    return this.mint(API_ID_PREFIXES.webhookEvent, at);
  }

  checkoutSessionId(at?: number): string {
    return this.mint(API_ID_PREFIXES.checkoutSession, at);
  }

  /** Escape hatch for the two tables whose ids are not in the public prefix table. */
  opaque(prefix: string, at?: number): string {
    return `${prefix}${this.generate(at)}`;
  }
}

/** Non-injected form for entity `@BeforeInsert` defaults and for migrations. */
export function newId(prefix: string): string {
  return `${prefix}${ulid()}`;
}

export { isPayzenoId };
