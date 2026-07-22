import type { MerchantId } from '@payzeno/contracts';
import { EVENT_SCHEMA_VERSIONS } from '@payzeno/contracts/events';
import type {
  EventType,
  PayloadOfType,
  PayzenoEvent,
  SettlementCompletedPayload,
  SettlementDuplicateDetectedPayload,
} from '@payzeno/contracts/events';

import { TEST_CHARGE_ID, TEST_MERCHANT_ID } from './ids';

let seq = 0;

function nextEventId(): string {
  seq += 1;
  return `evt_${seq.toString(36).padStart(10, '0')}`;
}

export interface EnvelopeOverrides {
  id?: string;
  occurred_at?: string;
  source?: 'payzeno-api' | 'payzeno-ledger' | 'payzeno-billing-legacy';
  correlation_id?: string;
  causation_id?: string | null;
  merchant_id?: MerchantId | null;
  livemode?: boolean;
}

/**
 * Builds a real `EventEnvelope` for `type`, stamping `version` from
 * `EVENT_SCHEMA_VERSIONS` rather than hardcoding `1`. `settlement.completed` is
 * version **2** and `LedgerEventsConsumer` branches on that, so a factory that always
 * emitted `1` would make the v2 chunk-tracking branch unreachable from any test.
 */
export function makeEnvelope<T extends EventType>(
  type: T,
  payload: PayloadOfType<T>,
  overrides: EnvelopeOverrides = {},
): PayzenoEvent {
  const envelope = {
    id: overrides.id ?? nextEventId(),
    type,
    version: EVENT_SCHEMA_VERSIONS[type],
    occurred_at: overrides.occurred_at ?? '2026-01-13T04:00:00.000Z',
    source: overrides.source ?? 'payzeno-ledger',
    correlation_id: overrides.correlation_id ?? 'req_test_correlation',
    causation_id: overrides.causation_id ?? null,
    merchant_id: overrides.merchant_id === undefined ? TEST_MERCHANT_ID : overrides.merchant_id,
    livemode: overrides.livemode ?? true,
    payload,
  };
  return envelope as unknown as PayzenoEvent;
}

/** The arc-INC event: the ledger telling us a settlement posting was already made. */
export function makeDuplicateDetectedEvent(
  payload: Partial<SettlementDuplicateDetectedPayload> = {},
  overrides: EnvelopeOverrides = {},
): PayzenoEvent {
  const full: SettlementDuplicateDetectedPayload = {
    batch_id: 'sb_20260113_wf',
    item_id: 'ri_000042',
    charge_id: TEST_CHARGE_ID,
    merchant_id: TEST_MERCHANT_ID,
    idempotency_key: `settle:sb_20260113_wf:${TEST_CHARGE_ID}`,
    existing_transaction_id: 'ltx_000777',
    detected_by: 'retry_scheduler',
    amount_minor: 4_500,
    currency: 'GBP',
    detected_at: '2026-01-13T04:11:00.000Z',
    ...payload,
  };
  return makeEnvelope('settlement.duplicate_detected', full, overrides);
}

/** `settlement.completed` v2 — chunked, which is what PAY-2052 added tracking for. */
export function makeSettlementCompletedEvent(
  payload: Partial<SettlementCompletedPayload> = {},
  overrides: EnvelopeOverrides = {},
): PayzenoEvent {
  const full = {
    batch_id: 'sb_20260113_wf',
    acquirer: 'worldflow',
    currency: 'GBP',
    processing_date: '2026-01-13',
    item_count: 3_140,
    settled_count: 3_140,
    failed_count: 0,
    chunk_index: 0,
    chunk_count: 1,
    charge_ids: [TEST_CHARGE_ID],
    completed_at: '2026-01-13T04:20:00.000Z',
    ...payload,
  } as unknown as SettlementCompletedPayload;
  return makeEnvelope('settlement.completed', full, {
    merchant_id: null,
    ...overrides,
  });
}

/** A batch of envelopes of the same type — for consumer long-poll / dedupe specs. */
export function makeEnvelopeBatch<T extends EventType>(
  type: T,
  payloads: ReadonlyArray<PayloadOfType<T>>,
): PayzenoEvent[] {
  return payloads.map((p) => makeEnvelope(type, p));
}

