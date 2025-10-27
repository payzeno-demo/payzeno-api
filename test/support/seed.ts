import type { ApiKeyScope, Merchant, MerchantId, UserRole } from '@payzeno/contracts';
import { API_KEY_SCOPES } from '@payzeno/contracts';

import { ApiKeyHasher } from 'src/auth/api-key/api-key.hasher';
import { ApiKeyEntity } from 'src/merchants/api-keys/api-key.entity';
import { MerchantEntity } from 'src/merchants/merchant.entity';
import { MerchantUserEntity } from 'src/merchants/users/merchant-user.entity';

import { makeMerchant } from 'test/factories/merchant.factory';
import type { TestApp } from './test-app';

/**
 * Seeding for the e2e suite.
 *
 * These write rows directly rather than going through `POST /v1/merchants`, on purpose:
 * a payments e2e that has to authenticate as staff and onboard a merchant before it can
 * assert anything about capture is really testing onboarding, and it fails for the wrong
 * reason every time the onboarding flow changes.
 *
 * The one thing seeding does NOT shortcut is the API key secret: it is hashed through
 * `ApiKeyHasher`, exactly as `ApiKeysService` does, so `ApiKeyGuard`'s split-token
 * lookup path is exercised by every authenticated request in the suite.
 */

export interface SeededMerchant {
  merchant: Merchant;
  /** Full `sk_test_…` / `sk_live_…` token. Send it as `Authorization: Bearer <token>`. */
  apiKey: string;
  apiKeyId: string;
  userId: string;
  email: string;
}

let counter = 0;

export async function seedMerchant(
  testApp: TestApp,
  overrides: Partial<Merchant> = {},
  scopes: ApiKeyScope[] = [...API_KEY_SCOPES],
): Promise<SeededMerchant> {
  counter += 1;
  const merchant = makeMerchant({ id: `mch_e2e${counter.toString().padStart(4, '0')}`, ...overrides });

  const manager = testApp.dataSource.manager;
  await manager.insert(MerchantEntity, {
    id: merchant.id,
    legal_name: merchant.legal_name,
    display_name: merchant.display_name,
    country: merchant.country,
    default_currency: merchant.default_currency,
    status: merchant.status,
    mcc: merchant.mcc,
    risk_tier: merchant.risk_tier,
    payout_schedule: merchant.payout_schedule,
    reserve_bps: merchant.reserve_bps,
    reserve_hold_days: merchant.reserve_hold_days,
    pricing_model: merchant.pricing_model,
    platform_fee_bps: merchant.platform_fee_bps,
    platform_fee_fixed_minor: merchant.platform_fee_fixed_minor,
    payout_delay_days: merchant.payout_delay_days,
    settlement_tolerance_minor: merchant.settlement_tolerance_minor,
    capture_at_settlement: merchant.capture_at_settlement,
    livemode: merchant.livemode,
    metadata: merchant.metadata,
  });

  const userId = `usr_e2e${counter.toString().padStart(4, '0')}`;
  const email = `owner+${counter}@aurora.example`;
  await manager.insert(MerchantUserEntity, {
    id: userId,
    merchant_id: merchant.id,
    email,
    full_name: 'Aurora Owner',
    role: 'owner' as UserRole,
    // argon2 hash of "correct-horse-battery" — the password every auth e2e logs in with.
    password_hash:
      '$argon2id$v=19$m=65536,t=3,p=4$ZTJlc2VlZHNlZWRzZWVk$0ZQ1J0xUeE2i0m5oQ0oQ8m0h1G2p3q4r5s6t7u8v9w0',
    status: 'active',
  });

  const hasher = testApp.app.get(ApiKeyHasher);
  const apiKeyId = `ak_e2e${counter.toString().padStart(4, '0')}`;
  const secret = `s${counter.toString(36)}${'x'.repeat(24)}`;
  const prefix = merchant.livemode ? 'sk_live_' : 'sk_test_';
  const token = `${prefix}${apiKeyId.slice(-8)}_${secret}`;

  await manager.insert(ApiKeyEntity, {
    id: apiKeyId,
    merchant_id: merchant.id,
    name: 'e2e key',
    mode: merchant.livemode ? 'live' : 'test',
    prefix,
    last_four: secret.slice(-4),
    lookup_hash: hasher.lookupHash(secret),
    secret_hash: await hasher.hashSecret(secret),
    scopes,
    livemode: merchant.livemode,
  });

  return { merchant, apiKey: token, apiKeyId, userId, email };
}

/** Two merchants, for every cross-tenant assertion in `merchant-scope.e2e-spec.ts`. */
export async function seedTwoMerchants(
  testApp: TestApp,
): Promise<{ own: SeededMerchant; other: SeededMerchant }> {
  const own = await seedMerchant(testApp, { display_name: 'Aurora' });
  const other = await seedMerchant(testApp, { display_name: 'Borealis' });
  return { own, other };
}

export function bearer(seeded: SeededMerchant): string {
  return `Bearer ${seeded.apiKey}`;
}

export function idempotencyKey(label: string, merchantId: MerchantId): string {
  return `${merchantId}:${label}:${Date.now().toString(36)}`;
}
