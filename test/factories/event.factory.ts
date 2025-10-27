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

