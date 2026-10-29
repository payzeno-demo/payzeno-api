/**
 * The demo world: four active merchants, their users, keys, bank accounts, webhook endpoints
 * and approved onboarding, plus one staff operator per role (admin, risk, support, finance).
 *
 *   docker compose run --rm --no-deps payzeno-api node dist/scripts/seed-demo.js
 *
 * It boots a Nest application context (`SeedDemoModule`: no HTTP, no jobs, consumers wired but
 * not polling) and goes through the real services, so the outbox carries real `merchant.*`
 * events and the ledger gets real charts of accounts — live from onboarding, test-mode
 * bootstrapped here.
 *
 * Idempotent. A second run finds the merchants it made and leaves them alone, but it mints
 * fresh api keys and rotates the webhook signing secret every time: neither plaintext can be
 * recovered after it is first shown, and the point of the output is to hand them out.
 *
 * stdout carries exactly one JSON document and nothing else; every log line goes to stderr.
 *
 * One step stands in for a flow that is not built yet, and says so where it happens: the bank
 * account validation callback. Two more skip a real flow on purpose, because the demo needs
 * known credentials and a trading merchant without a human in the loop: users are created with
 * a known password (no `team_invite` email), and onboarding is marked `approved` with the
 * profile the merchant would have submitted (no reviewer, no `onboarding_approved` email).
 */
import 'reflect-metadata';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  API_KEY_SCOPES,
  type BankAccountScheme,
  type BusinessProfile,
  type CurrencyCode,
  type MerchantId,
  type PublicEventType,
  type StaffRole,
  type UserRole,
} from '@payzeno/contracts';
import * as argon2 from 'argon2';
import type { Repository } from 'typeorm';


import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import { LedgerHttpClient } from '../ledger/ledger-http.client';
import { ApiKeysService } from '../merchants/api-keys/api-keys.service';
import { BankAccountEntity } from '../merchants/bank-accounts/bank-account.entity';
import { BankAccountsService } from '../merchants/bank-accounts/bank-accounts.service';
import { MerchantOnboardingService } from '../merchants/merchant-onboarding.service';
import type { MerchantEntity } from '../merchants/merchant.entity';
import { MerchantRepository } from '../merchants/merchant.repository';
import { MerchantsService } from '../merchants/merchants.service';
import { MerchantUserRepository } from '../merchants/users/merchant-user.repository';
import { MerchantUsersService } from '../merchants/users/users.service';
import { OnboardingService } from '../onboarding/onboarding.service';
import { StaffUser } from '../staff/staff-user.entity';
import { StaffUsersService } from '../staff/staff-users.service';
import { WebhookEndpointEntity } from '../webhooks/webhook-endpoint.entity';
import { WebhookEndpointsService } from '../webhooks/webhook-endpoints.service';

import { SeedDemoModule } from './seed-demo.module';

const ACTOR = 'seed-demo';

/** Where every demo shop receives its webhooks, inside the compose network. */
const WEBHOOK_BASE = 'http://sim-shops:3000/webhooks';

const WEBHOOK_EVENTS: PublicEventType[] = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'payment.canceled',
  'refund.created',
  'refund.succeeded',
  'refund.failed',
  'dispute.opened',
  'dispute.evidence_submitted',
  'dispute.closed',
];

interface DemoBankAccount {
  scheme: BankAccountScheme;
  accountNumber: string;
  routingNumber: string;
  holder: string;
  bankName: string;
}

interface DemoMerchant {
  slug: string;
  legalName: string;
  displayName: string;
  statementDescriptor: string;
  country: string;
  currency: CurrencyCode;
  mcc: string;
  /** None for JPY: no supported payout scheme settles yen. */
  bank: DemoBankAccount | null;
  /** What the merchant would have submitted at onboarding; `support_email` is derived. */
  profile: Omit<BusinessProfile, 'support_email'>;
  representative: { fullName: string; dateOfBirth: string };
}

/** Published sandbox numbers: valid checksums, no real account behind any of them. */
const MERCHANTS: readonly DemoMerchant[] = [
  {
    slug: 'northwind',
    legalName: 'Northwind Coffee Roasters LLC',
    displayName: 'Northwind Coffee Roasters',
    statementDescriptor: 'NORTHWIND COFFEE',
    country: 'US',
    currency: 'USD',
    mcc: '5499',
    bank: {
      scheme: 'aba',
      accountNumber: '000123456789',
      routingNumber: '110000000',
      holder: 'Northwind Coffee Roasters LLC',
      bankName: 'Sandbox National Bank',
    },
    profile: {
      business_type: 'company',
      website: 'https://northwind-coffee.example',
      product_description: 'Specialty coffee beans and brewing equipment, sold online and shipped within the US.',
      address_line1: '410 Harbor Way',
      city: 'Seattle',
      postal_code: '98101',
      registration_number: 'WA-604-118-223',
    },
    representative: { fullName: 'Dana Whitfield', dateOfBirth: '1984-03-12' },
  },
  {
    slug: 'velo',
    legalName: 'Velo Atelier SAS',
    displayName: 'Velo Atelier',
    statementDescriptor: 'VELO ATELIER',
    country: 'FR',
    currency: 'EUR',
    mcc: '5940',
    bank: {
      scheme: 'iban',
      accountNumber: 'FR1420041010050500013M02606',
      // The BIC, which the vault takes in routing_number for an IBAN account.
      routingNumber: 'SBXAFRPPXXX',
      holder: 'Velo Atelier SAS',
      bankName: 'Banque Sandbox',
    },
    profile: {
      business_type: 'company',
      website: 'https://velo-atelier.example',
      product_description: 'Hand-built bicycles, parts and repair bookings for customers across the EU.',
      address_line1: '12 Rue des Ateliers',
      city: 'Lyon',
      postal_code: '69002',
      registration_number: 'RCS Lyon 852 114 903',
    },
    representative: { fullName: 'Camille Durand', dateOfBirth: '1979-11-02' },
  },
  {
    slug: 'brightside',
    legalName: 'Brightside Tickets Ltd',
    displayName: 'Brightside Tickets',
    statementDescriptor: 'BRIGHTSIDE TICKETS',
    country: 'GB',
    currency: 'GBP',
    mcc: '7922',
    bank: {
      scheme: 'uk_sort_code',
      accountNumber: '00012345',
      routingNumber: '108800',
      holder: 'Brightside Tickets Ltd',
      bankName: 'Sandbox Bank UK',
    },
    profile: {
      business_type: 'company',
      website: 'https://brightside-tickets.example',
      product_description: 'Tickets for live music and comedy events at independent UK venues.',
      address_line1: '88 Camden High Street',
      city: 'London',
      postal_code: 'NW1 0LT',
      registration_number: '12345678',
    },
    representative: { fullName: 'Priya Natarajan', dateOfBirth: '1990-06-21' },
  },
  {
    slug: 'kumo',
    legalName: 'Kumo Tea House KK',
    displayName: 'Kumo Tea House',
    statementDescriptor: 'KUMO TEA HOUSE',
    country: 'JP',
    currency: 'JPY',
    mcc: '5814',
    bank: null,
    profile: {
      business_type: 'company',
      website: 'https://kumo-tea.example',
      product_description: 'Loose-leaf Japanese teas and tea ware, sold from a Kyoto shop and online.',
      address_line1: '3-14 Gion-machi',
      city: 'Kyoto',
      postal_code: '605-0073',
      registration_number: '1300-01-098765',
    },
    representative: { fullName: 'Haruto Sato', dateOfBirth: '1975-01-30' },
  },
];

/** One operator per role. `admin` passes every role check; the other three are peers. */
const STAFF: ReadonlyArray<{ email: string; fullName: string; role: StaffRole; password: string }> = [
  { email: 'ops@payzeno.example', fullName: 'Payzeno Ops', role: 'admin', password: 'Payzeno-staff-demo-1' },
  { email: 'risk@payzeno.example', fullName: 'Rhea Riskwell', role: 'risk', password: 'Payzeno-risk-demo-1' },
  { email: 'support@payzeno.example', fullName: 'Sam Supportson', role: 'support', password: 'Payzeno-support-demo-1' },
  { email: 'finance@payzeno.example', fullName: 'Fin Ledgerly', role: 'finance', password: 'Payzeno-finance-demo-1' },
];

interface SeedUser {
  email: string;
  password: string;
  role: UserRole;
}

interface SeedOutput {
  merchants: Array<{
    slug: string;
    merchant_id: MerchantId;
    display_name: string;
    currency: CurrencyCode;
    api_keys: { live: string; test: string };
    webhook: { endpoint_id: string; signing_secret: string };
    users: SeedUser[];
  }>;
  staff: Array<{ email: string; password: string; role: StaffRole }>;
}

function log(msg: string, ctx: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ level: 'info', msg, ...ctx })}\n`);
}

function usersFor(slug: string): Array<SeedUser & { fullName: string }> {
  return [
    { email: `owner@${slug}.example`, password: `Demo-${slug}-owner-1`, role: 'owner', fullName: 'Shop Owner' },
    {
      email: `developer@${slug}.example`,
      password: `Demo-${slug}-developer-1`,
      role: 'developer',
      fullName: 'Shop Developer',
    },
  ];
}

async function seedMerchant(app: INestApplicationContext, demo: DemoMerchant): Promise<SeedOutput['merchants'][number]> {
  const config = app.get<ApiConfig>(API_CONFIG);
  const merchants = app.get(MerchantRepository, { strict: false });
  const merchantsService = app.get(MerchantsService, { strict: false });
  const onboarding = app.get(MerchantOnboardingService, { strict: false });
  const ledger = app.get(LedgerHttpClient, { strict: false });

  // --- the merchant, active, with live and test charts of accounts ---------
  let merchant: MerchantEntity | null = await merchants.findByLegalName(demo.legalName, demo.country);
  if (!merchant) {
    merchant = await onboarding.onboard(
      {
        legal_name: demo.legalName,
        display_name: demo.displayName,
        country: demo.country,
        default_currency: demo.currency,
        mcc: demo.mcc,
        metadata: { demo_slug: demo.slug },
      },
      true,
      ACTOR,
      { bootstrapTestMode: true },
    );
    log('seed.merchant_onboarded', { slug: demo.slug, merchant_id: merchant.id });
  }
  const merchantId = merchant.id;

  if (merchant.status === 'pending_review') {
    await merchantsService.changeStatus(merchantId, 'active', 'demo seed', ACTOR);
  }
  if (merchant.statementDescriptor !== demo.statementDescriptor) {
    await merchantsService.update(merchantId, { statement_descriptor: demo.statementDescriptor }, ACTOR);
  }
  // Onboarding bootstraps both charts now; a merchant seeded before that only has the live one,
  // and the bootstrap is idempotent.
  await ledger.bootstrapAccounts(merchantId, demo.currency, false);

  // --- onboarding: approved, with the profile the merchant would have submitted -----------
  await app.get(OnboardingService, { strict: false }).markApprovedForSeed(
    merchantId,
    { ...demo.profile, support_email: `support@${demo.slug}.example` },
    { full_name: demo.representative.fullName, date_of_birth: demo.representative.dateOfBirth, email: `owner@${demo.slug}.example` },
  );

  const live: MerchantScope = { merchantId, livemode: true };

  // --- users -------------------------------------------------------------
  const userRows = app.get(MerchantUserRepository, { strict: false });
  const usersService = app.get(MerchantUsersService, { strict: false });
  const users: SeedUser[] = [];
  for (const user of usersFor(demo.slug)) {
    const passwordHash = await argon2.hash(user.password, { type: argon2.argon2id });
    const existing = await userRows.findByEmailForMerchant(merchantId, user.email);
    if (existing) {
      // Back to the known password (and `active`) every run: the demo hands these out.
      await userRows.activateWithPassword(merchantId, existing.id, passwordHash);
    } else {
      // Created directly rather than invited, so the seed does not mail an invitation nobody
      // will accept to an address that already has its password.
      await usersService.createUser(
        merchantId,
        { email: user.email, full_name: user.fullName, role: user.role },
        { status: 'active', passwordHash },
      );
    }
    users.push({ email: user.email, password: user.password, role: user.role });
  }

  // --- api keys: fresh every run ------------------------------------------
  const keys = app.get(ApiKeysService, { strict: false });
  const liveKey = await keys.create(
    merchantId,
    { name: 'demo seed (live)', mode: 'live', scopes: [...API_KEY_SCOPES] },
    live,
  );
  const testKey = await keys.create(
    merchantId,
    { name: 'demo seed (test)', mode: 'test', scopes: [...API_KEY_SCOPES] },
    { merchantId, livemode: false },
  );

  // --- a validated default bank account ----------------------------------
  if (demo.bank) {
    await seedBankAccount(app, config, demo, live);
  }

  // --- webhook endpoint: created once, secret rotated every run ------------
  const endpoints = app.get(WebhookEndpointsService, { strict: false });
  const url = `${WEBHOOK_BASE}/${demo.slug}`;
  const current = (await endpoints.listForInternalCaller(merchantId)).find(
    (endpoint) => endpoint.url === url && endpoint.livemode,
  );
  if (current && current.status !== 'enabled') {
    // Payzeno has no re-enable route yet. A demo endpoint the delivery job disabled while the
    // shops were down comes back enabled with a clean failure count, as a fresh one would be.
    const rows = app.get<Repository<WebhookEndpointEntity>>(getRepositoryToken(WebhookEndpointEntity), {
      strict: false,
    });
    await rows.update({ id: current.id }, { status: 'enabled', consecutiveFailureCount: 0 });
  }
  const endpoint = current
    ? await endpoints.rotateSecret(live, current.id)
    : await endpoints.create(merchantId, true, { url, enabled_events: WEBHOOK_EVENTS });
  if (!endpoint.signing_secret) {
    throw new Error(`webhook endpoint ${endpoint.id} came back without its signing secret`);
  }

  log('seed.merchant_ready', { slug: demo.slug, merchant_id: merchantId });

  return {
    slug: demo.slug,
    merchant_id: merchantId,
    display_name: demo.displayName,
    currency: demo.currency,
    api_keys: { live: liveKey.secret, test: testKey.secret },
    webhook: { endpoint_id: endpoint.id, signing_secret: endpoint.signing_secret },
    users,
  };
}

async function seedBankAccount(
  app: INestApplicationContext,
  config: ApiConfig,
  demo: DemoMerchant,
  scope: MerchantScope,
): Promise<void> {
  const bank = demo.bank;
  if (!bank) return;

  const accounts = app.get(BankAccountsService, { strict: false });
  const existing = await accounts.list(scope, { limit: 100 });
  if (existing.data.some((account) => account.currency === demo.currency && account.is_default && account.status === 'validated')) {
    return;
  }

  // The account number goes to the vault and only the `bat_` token comes back, exactly as from
  // the console's bank-account form. Payzeno never holds the digits.
  const response = await fetch(`${config.vault.baseUrl}/public/tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'bank_account',
      scheme: bank.scheme,
      account_number: bank.accountNumber,
      routing_number: bank.routingNumber,
      account_holder_name: bank.holder,
    }),
  });
  const body = (await response.json()) as { token?: string; last_four?: string; message?: string };
  if (!response.ok || !body.token) {
    throw new Error(`vault refused the ${demo.slug} bank account: ${response.status} ${body.message ?? ''}`);
  }

  const created = await accounts.create(scope, {
    country: demo.country,
    currency: demo.currency,
    scheme: bank.scheme,
    bank_account_token: body.token,
    account_holder_name: bank.holder,
    is_default: true,
  });

  // Stands in for the vault's validation callback, which is not built yet: the row lands
  // `new`, and only a `validated` account is payable.
  const rows = app.get<Repository<BankAccountEntity>>(getRepositoryToken(BankAccountEntity), { strict: false });
  await rows.update(
    { id: created.id },
    {
      status: 'validated',
      bankName: bank.bankName,
      lastFour: body.last_four ?? bank.accountNumber.slice(-4),
      routingLastFour: bank.scheme === 'aba' ? bank.routingNumber.slice(-4) : null,
      ibanLastFour: bank.scheme === 'iban' ? bank.accountNumber.slice(-4) : null,
      bic: bank.scheme === 'iban' ? bank.routingNumber : null,
      sortCodeLastFour: bank.scheme === 'uk_sort_code' ? bank.routingNumber.slice(-4) : null,
    },
  );
}

async function seedStaff(app: INestApplicationContext): Promise<SeedOutput['staff']> {
  const staff = app.get(StaffUsersService, { strict: false });
  const rows = app.get<Repository<StaffUser>>(getRepositoryToken(StaffUser), { strict: false });
  const out: SeedOutput['staff'] = [];

  for (const member of STAFF) {
    const existing = await rows.findOne({ where: { email: member.email } });
    if (existing) {
      await rows.update({ id: existing.id }, { passwordHash: await argon2.hash(member.password, { type: argon2.argon2id }) });
    } else {
      await staff.create({ email: member.email, fullName: member.fullName, password: member.password, role: member.role });
    }
    out.push({ email: member.email, password: member.password, role: member.role });
  }
  return out;
}

async function main(): Promise<void> {
  // Nest's own logger writes everything but errors to stdout; errors only, and those go to stderr.
  const app = await NestFactory.createApplicationContext(SeedDemoModule, { logger: ['error'] });
  try {
    const output: SeedOutput = { merchants: [], staff: [] };
    for (const demo of MERCHANTS) {
      output.merchants.push(await seedMerchant(app, demo));
    }
    output.staff = await seedStaff(app);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'seed.failed', error: err instanceof Error ? err.stack ?? err.message : String(err) })}\n`,
  );
  process.exit(1);
});
