/**
 * `@LivemodeOnly()` — refuses a test-mode principal.
 *
 * Money movement has no test-mode analogue: there is no test bank, and a `sk_test_` key that
 * could schedule a payout would be scheduling a real ACH debit against the merchant's real
 * account. Sites: POST /v1/payouts, POST /v1/payouts/:id/cancel,
 * POST /v1/settlements/:b/items/:i/retry.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const LIVEMODE_ONLY_KEY = 'payzeno:livemode_only';

export const LivemodeOnly = (): CustomDecorator => SetMetadata(LIVEMODE_ONLY_KEY, true);
