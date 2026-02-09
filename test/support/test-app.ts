import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { AppModule } from 'src/app.module';
import { StaticFeatureFlags } from 'src/common/flags/static-feature-flags';
import { FeatureFlags } from 'src/common/flags/feature-flags';
import { Clock } from 'src/common/time/clock';
import { HttpExceptionFilter } from 'src/common/filters/http-exception.filter';
import { validationExceptionFactory } from 'src/common/filters/validation-exception.factory';
import { LedgerHttpClient } from 'src/ledger/ledger-http.client';

import { FixedClock } from './fixed-clock';
import { InMemoryLedgerClient } from './in-memory-ledger';

export interface TestAppOverrides {
  /** Flag values the booted app should see. Defaults mirror production: everything off. */
  flags?: Record<string, boolean>;
  /** Instant every `Clock` consumer sees. */
  now?: string;
  /** Bring your own ledger double — the settlement specs arm rejections on theirs. */
  ledger?: InMemoryLedgerClient;
  /** Escape hatch for a spec that needs one more provider swapped. */
  customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

export interface TestApp {
  app: INestApplication;
  ledger: InMemoryLedgerClient;
  clock: FixedClock;
  flags: StaticFeatureFlags;
  dataSource: DataSource;
  close: () => Promise<void>;
}

/**
 * Boots the real `AppModule` with three seams swapped:
 *
 *  - `LedgerHttpClient` → `InMemoryLedgerClient`, so no ledger process is needed;
 *  - `Clock` → `FixedClock`, so refund windows and auth expiry are deterministic;
 *  - `FeatureFlags` → `StaticFeatureFlags`, the second production implementation
 *    (blueprint §9.2 — it is wired here and in the `jobs --dry-run` CLI path, and
 *    nowhere else).
 *
 * Everything else is production wiring: the same middleware chain, the same guards, the
 * same `HttpExceptionFilter`. An e2e test that swapped the guards would assert nothing
 * about the guards.
 */
export async function createTestApp(overrides: TestAppOverrides = {}): Promise<TestApp> {
  const ledger = overrides.ledger ?? new InMemoryLedgerClient();
  const flags = new StaticFeatureFlags({
    ledger_owns_invoices: false,
    ledger_owns_fees: false,
    redact_pan_in_logs: true,
    ...(overrides.flags ?? {}),
  });

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(LedgerHttpClient)
    .useValue(ledger)
    .overrideProvider(Clock)
    .useValue(clock)
    .overrideProvider(FeatureFlags)
    .useValue(flags);

  if (overrides.customise) {
    builder = overrides.customise(builder);
  }

  const moduleRef = await builder.compile();
  const dataSource = app.get(DataSource);

  return {
    app,
    ledger,
    clock,
    flags,
    dataSource,
    close: async () => {
      await app.close();
    },
  };
}

/** The HTTP server supertest binds to. Keeps `request(app.getHttpServer())` off every line. */
export function serverOf(testApp: TestApp): unknown {
  return testApp.app.getHttpServer();
}
