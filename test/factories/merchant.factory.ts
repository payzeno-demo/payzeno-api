import { nextId } from './ids';
import type {
  BankAccount,
  CreateMerchantRequest,
  Merchant,
  MerchantId,
  User,
} from '@payzeno/contracts';


/**
 * `Merchant` exactly as `@payzeno/contracts` declares it — every field present, no
 * `as unknown as Merchant`. The deliberate `USES_TYPE` edge from the test tree into the
 * shared package (tests.md §2.1) only exists if the factory's return type is the
 * contract type, so it is annotated, not inferred.
 *
 * Defaults describe the *boring* merchant: active, standard risk, blended pricing,
 * immediate capture. Every arc-specific merchant is an override on top of this one —
 * `makeMerchant({ capture_at_settlement: true })` is arc INC's blast radius in one line.
 */
export function makeMerchant(overrides: Partial<Merchant> = {}): Merchant {
  const id: MerchantId = nextId('mch_');
  return {
    id,
    object: 'merchant',
    legal_name: 'Aurora Retail Ltd',
    display_name: 'Aurora',
    country: 'GB',
    default_currency: 'GBP',
    status: 'active',
    mcc: '5732',
    risk_tier: 'standard',
    payout_schedule: 'daily',
    reserve_bps: 0,
    reserve_hold_days: 0,
    pricing_model: 'blended',
    platform_fee_bps: 290,
    platform_fee_fixed_minor: 30,
    payout_delay_days: 2,
    settlement_tolerance_minor: 100,
    capture_at_settlement: false,
    livemode: true,
    metadata: {},
    created_at: '2025-11-01T09:00:00.000Z',
    updated_at: '2026-01-10T09:00:00.000Z',
    ...overrides,
  };
}

/** The eleven deferred-capture merchants of arc INC. Reserve + T+7 + capture at settlement. */
export function makeDeferredCaptureMerchant(overrides: Partial<Merchant> = {}): Merchant {
  return makeMerchant({
    capture_at_settlement: true,
    risk_tier: 'elevated',
    reserve_bps: 500,
    reserve_hold_days: 90,
    payout_delay_days: 7,
    mcc: '4722',
    ...overrides,
  });
}

export function makeUser(overrides: Partial<User> = {}): User {
  const merchantId = overrides.merchant_id ?? nextId('mch_');
  return {
    id: nextId('usr_'),
    object: 'user',
    merchant_id: merchantId,
    email: 'owner@aurora.example',
    full_name: 'Aurora Owner',
    role: 'owner',
    last_login_at: null,
    created_at: '2025-11-01T09:00:00.000Z',
    ...overrides,
  };
}

export function makeBankAccount(overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    id: nextId('ba_'),
    object: 'bank_account',
    merchant_id: overrides.merchant_id ?? nextId('mch_'),
    country: 'GB',
    currency: 'GBP',
    bank_name: 'Northbank',
    scheme: 'uk_sort_code',
    last_four: '4417',
    routing_last_four: null,
    iban_last_four: null,
    bic: 'NRTHGB2L',
    sort_code_last_four: '0021',
    status: 'validated',
    is_default: true,
    livemode: true,
    created_at: '2025-11-02T09:00:00.000Z',
    ...overrides,
  };
}
