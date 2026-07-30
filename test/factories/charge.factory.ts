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

export function makeThreeDSecure(
  overrides: Partial<ThreeDSecureResult> = {},
): ThreeDSecureResult {
  return {
    version: '2.2.0',
    authentication_flow: 'frictionless',
    result: 'authenticated',
    eci: '05',
    liability_shifted: true,
    ...overrides,
  };
}

/**
 * Default is an `authorized`, not-yet-captured charge: the state
 * `ChargeCaptureService.captureCharge` accepts and `RefundsService.create` rejects.
 * `processor_reference` is always set — it is half of `uq_charge_processor_reference`
 * (migration 16, committed during the incident) and the reconciliation match key.
 */
export function makeCharge(overrides: Partial<Charge> = {}): Charge {
  const id = overrides.id ?? nextId('ch_');
  return {
    id,
    object: 'charge',
    merchant_id: TEST_MERCHANT_ID,
    payment_intent_id: TEST_PAYMENT_INTENT_ID,
    amount_minor: 4_500,
    captured_amount_minor: 0,
    refunded_amount_minor: 0,
    currency: 'GBP',
    status: 'authorized',
    card: makeCard(),
    acquirer: 'worldflow',
    network_transaction_id: `ntx_${nextId('ch_').slice(4, 20)}`,
    processor_reference: `wf_auth_${nextId('ch_').slice(4, 16)}`,
    authorization_code: 'A17742',
    capture_method: 'automatic',
    three_d_secure: makeThreeDSecure(),
    sca_exemption: null,
    risk_score: 12,
    failure_code: null,
    failure_message: null,
    settlement_batch_id: null,
    livemode: true,
    metadata: {},
    authorized_at: '2026-01-12T10:00:03.000Z',
    captured_at: null,
    settled_at: null,
    authorization_expires_at: '2026-01-19T10:00:03.000Z',
    created_at: '2026-01-12T10:00:00.000Z',
    updated_at: '2026-01-12T10:00:03.000Z',
    ...overrides,
  };
}

/** Captured, refundable. `RefundPolicyService` accepts this one. */
export function makeCapturedCharge(overrides: Partial<Charge> = {}): Charge {
  const base = makeCharge(overrides);
  return {
    ...base,
    status: 'captured',
    captured_amount_minor: overrides.captured_amount_minor ?? base.amount_minor,
    captured_at: overrides.captured_at ?? '2026-01-12T10:05:00.000Z',
  };
}

/** Settled into a batch — the shape `UnsettledChargeSweepJob` should NOT touch. */
export function makeSettledCharge(overrides: Partial<Charge> = {}): Charge {
  const base = makeCapturedCharge(overrides);
  return {
    ...base,
    status: 'settled',
    settlement_batch_id: overrides.settlement_batch_id ?? 'sb_20260113_wf',
    settled_at: overrides.settled_at ?? '2026-01-13T04:10:00.000Z',
  };
}

/** Deferred-capture charge: the ledger captures this at settlement, not payzeno-api. */
export function makeDeferredCaptureCharge(overrides: Partial<Charge> = {}): Charge {
  return makeCharge({
    capture_method: 'manual',
    authorization_expires_at: '2026-02-11T10:00:03.000Z',
    ...overrides,
  });
}

export function makeDeclinedCharge(overrides: Partial<Charge> = {}): Charge {
  return makeCharge({
    status: 'failed',
    authorization_code: null,
    authorized_at: null,
    authorization_expires_at: null,
    failure_code: 'insufficient_funds',
    failure_message: 'Issuer declined: insufficient funds',
    three_d_secure: null,
    ...overrides,
  });
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
