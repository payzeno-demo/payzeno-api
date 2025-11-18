/**
 * FeatureFlags — an injectable abstract class, not an interface, because Nest needs a runtime
 * token to resolve it and a `Symbol` token here would mean every consumer writes
 * `@Inject(FEATURE_FLAGS)`. Two concretes: EnvFeatureFlags (prod) and StaticFeatureFlags
 * (test-app.ts and the `jobs --dry-run` CLI).
 */
import { Injectable } from '@nestjs/common';

import type { FlagName } from './flag-names';

@Injectable()
export abstract class FeatureFlags {
  abstract isEnabled(flag: FlagName): boolean;

  /** Snapshot for the health payload and for the audit trail on a flag-branching decision. */
  abstract snapshot(): Record<FlagName, boolean>;

  isDisabled(flag: FlagName): boolean {
    return !this.isEnabled(flag);
  }

  /**
   * Branches on a flag and returns the taken arm's value. Exists so that
   * `InvoiceSourceResolver` reads as one expression and so the dead arm is visibly dead
   * rather than hidden behind an early return.
   */
  select<T>(flag: FlagName, whenOn: () => T, whenOff: () => T): T {
    return this.isEnabled(flag) ? whenOn() : whenOff();
  }
}
