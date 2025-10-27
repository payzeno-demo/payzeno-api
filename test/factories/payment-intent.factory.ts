import { nextId, TEST_CHARGE_ID, TEST_MERCHANT_ID } from './ids';
import type {
  CreatePaymentIntentRequest,
  MerchantId,
  NextAction,
  PaymentIntent,
  PaymentIntentStatus,
} from '@payzeno/contracts';


/**
 * A `PaymentIntent` in the contracts shape. Default is the state a freshly created
 * intent with a payment method is in — `requires_confirmation` — because that is the
 * one every flow spec starts from.
 *
 * `client_secret` is present and deterministic: `ClientSecretGuard` splits on the
 * `_secret_` marker and the auth specs assert on that split, so a random opaque blob
 * would make those tests untestable rather than realistic.
 */
export function makePaymentIntent(overrides: Partial<PaymentIntent> = {}): PaymentIntent {
  const id = overrides.id ?? nextId('pi_');
  const merchantId: MerchantId = overrides.merchant_id ?? TEST_MERCHANT_ID;
  return {
    id,
    object: 'payment_intent',
    merchant_id: merchantId,
    amount_minor: 4_500,
    currency: 'GBP',
    status: 'requires_confirmation',
    capture_method: 'automatic',
    customer_reference: 'cus_aurora_881',
    description: 'Order 4471',
    statement_descriptor: 'AURORA',
    latest_charge_id: null,
    client_secret: `${id}_secret_9f2c41ab`,
    next_action: null,
    livemode: true,
    metadata: {},
    created_at: '2026-01-12T10:00:00.000Z',
    updated_at: '2026-01-12T10:00:00.000Z',
    canceled_at: null,
    cancellation_reason: null,
    ...overrides,
  };
}

