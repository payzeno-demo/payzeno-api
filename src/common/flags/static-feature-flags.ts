/**
 * The second FeatureFlags implementation. Wired in two places, neither of which is a
 * request-serving process:
 *
 *   test/support/test-app.ts   — a suite that needs the ledger arm of InvoiceSourceResolver
 *   src/jobs/cli.ts            — `jobs --dry-run`, which must not take a cutover branch
 *
 * It is therefore dead code in the deployed API, on purpose.
 */
import { Injectable } from '@nestjs/common';

import { FeatureFlags } from './feature-flags';
import { ALL_FLAG_NAMES, type FlagName } from './flag-names';

@Injectable()
export class StaticFeatureFlags extends FeatureFlags {
  private readonly values: Record<FlagName, boolean>;

  constructor(overrides: Partial<Record<FlagName, boolean>> = {}) {
    super();
    const base = {} as Record<FlagName, boolean>;
    for (const name of ALL_FLAG_NAMES) {
      base[name] = false;
    }
    this.values = { ...base, ...overrides };
  }

  isEnabled(flag: FlagName): boolean {
    return this.values[flag] === true;
  }

  snapshot(): Record<FlagName, boolean> {
    return { ...this.values };
  }

  /** Mutable for a single test's arrange step. Never called from src/. */
  set(flag: FlagName, enabled: boolean): void {
    this.values[flag] = enabled;
  }
}
