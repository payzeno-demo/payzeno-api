import { nextId, TEST_CHARGE_ID, TEST_MERCHANT_ID, TEST_PAYMENT_INTENT_ID } from './ids';
import type {
  CardSummary,
  Charge,
  Dispute,
  Refund,
  ThreeDSecureResult,
} from '@payzeno/contracts';


export function makeCard(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    brand: 'visa',
    last_four: '4242',
    exp_month: 11,
    exp_year: 2029,
    country: 'GB',
    funding: 'credit',
    ...overrides,
  };
}

export function makeRefund(overrides: Partial<Refund> = {}): Refund {
  return {
    id: nextId('re_'),
    object: 'refund',
    merchant_id: TEST_MERCHANT_ID,
    charge_id: TEST_CHARGE_ID,
    amount_minor: 4_500,
    currency: 'GBP',
    status: 'pending',
    reason: 'requested_by_customer',
    failure_reason: null,
    processor_reference: null,
    metadata: {},
    created_at: '2026-01-14T09:00:00.000Z',
    succeeded_at: null,
    ...overrides,
  };
}

export function makeDispute(overrides: Partial<Dispute> = {}): Dispute {
  return {
    id: nextId('dp_'),
    object: 'dispute',
    merchant_id: TEST_MERCHANT_ID,
    charge_id: TEST_CHARGE_ID,
    amount_minor: 4_500,
    fee_minor: 1_500,
    currency: 'GBP',
    status: 'needs_response',
    reason: 'fraudulent',
    network_reason_code: '10.4',
    evidence_due_by: '2026-01-27T23:59:59.000Z',
    evidence: {},
    is_charge_refundable: false,
    liability_shifted: false,
    submitted_at: null,
    resolved_at: null,
    created_at: '2026-01-13T08:00:00.000Z',
    ...overrides,
  };
}
