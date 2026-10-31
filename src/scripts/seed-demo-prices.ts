/**
 * The demo world's recurring prices (RFC platform-v2 §6), for the shops' subscription products:
 *
 *   northwind  "Monthly Subscription"  USD 38.00 / month
 *   kumo       "Tea Club"              JPY 3000 / month
 *
 * each in live and test mode. Run after `seed-demo` (it finds the merchants by the
 * `demo_slug` metadata that seed wrote):
 *
 *   docker compose run --rm --no-deps payzeno-api node dist/scripts/seed-demo-prices.js
 *
 * Idempotent: a price is found again by `metadata.demo_price` and reused, never duplicated —
 * prices are immutable, and a second run must hand out the same ids the shops already hold.
 * stdout carries exactly one JSON document; every log line goes to stderr.
 */
import 'reflect-metadata';

import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { CurrencyCode, MinorUnits } from '@payzeno/contracts';

import type { PriceEntity } from '../billing/recurring/price.entity';
import { PriceRepository } from '../billing/recurring/price.repository';
import { PricesService } from '../billing/recurring/prices.service';
import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { MerchantRepository } from '../merchants/merchant.repository';

import { SeedDemoModule } from './seed-demo.module';

interface DemoPrice {
  slug: string;
  key: string;
  productName: string;
  currency: CurrencyCode;
  unitAmountMinor: MinorUnits;
}

interface SeededPrice {
  slug: string;
  price_id: string;
  product_name: string;
  currency: CurrencyCode;
  unit_amount_minor: MinorUnits;
  livemode: boolean;
}

const PRICES: DemoPrice[] = [
  { slug: 'northwind', key: 'northwind-monthly', productName: 'Monthly Subscription', currency: 'USD', unitAmountMinor: 3_800 },
  { slug: 'kumo', key: 'kumo-tea-club', productName: 'Tea Club', currency: 'JPY', unitAmountMinor: 3_000 },
];

function log(msg: string, ctx: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({ level: 'info', msg, ...ctx })}\n`);
}

async function findExisting(prices: PriceRepository, scope: MerchantScope, key: string): Promise<PriceEntity | null> {
  return prices
    .scopedQuery(scope)
    .andWhere(`price.metadata ->> 'demo_price' = :key`, { key })
    .orderBy('price.created_at', 'ASC')
    .getOne();
}

async function seedPrice(app: INestApplicationContext, demo: DemoPrice, livemode: boolean): Promise<SeededPrice> {
  const merchants = app.get(MerchantRepository, { strict: false });
  const merchant = await merchants
    .createQueryBuilder('merchant')
    .where(`merchant.metadata ->> 'demo_slug' = :slug`, { slug: demo.slug })
    .getOne();
  if (!merchant) {
    throw new Error(`demo merchant '${demo.slug}' not found — run seed-demo first`);
  }

  const scope: MerchantScope = { merchantId: merchant.id, livemode };
  const rows = app.get(PriceRepository, { strict: false });
  const existing = await findExisting(rows, scope, demo.key);
  const price =
    existing ??
    (await app.get(PricesService, { strict: false }).createInternal(scope, {
      product_name: demo.productName,
      unit_amount_minor: demo.unitAmountMinor,
      currency: demo.currency,
      recurring: { interval: 'month', interval_count: 1 },
      metadata: { demo_price: demo.key },
    }));

  log(existing ? 'seed.price_exists' : 'seed.price_created', { slug: demo.slug, price_id: price.id, livemode });
  return {
    slug: demo.slug,
    price_id: price.id,
    product_name: price.productName,
    currency: price.currency,
    unit_amount_minor: Number(price.unitAmountMinor),
    livemode,
  };
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(SeedDemoModule, { logger: ['error'] });
  try {
    const prices: SeededPrice[] = [];
    for (const demo of PRICES) {
      for (const livemode of [true, false]) {
        prices.push(await seedPrice(app, demo, livemode));
      }
    }
    process.stdout.write(`${JSON.stringify({ prices }, null, 2)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'fatal', msg: 'seed_prices.failed', error: err instanceof Error ? err.stack ?? err.message : String(err) })}\n`,
  );
  process.exit(1);
});
