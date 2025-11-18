import type { ApiConfig } from 'src/config/api-config.type';
import { EnvFeatureFlags } from 'src/common/flags/env-feature-flags';
import { FeatureFlags } from 'src/common/flags/feature-flags';
import { ALL_FLAG_NAMES, FLAG_NAMES, isFlagName } from 'src/common/flags/flag-names';
import { StaticFeatureFlags } from 'src/common/flags/static-feature-flags';

/**
 * `FeatureFlags` and both concretes. `EnvFeatureFlags` is production, `StaticFeatureFlags`
 * is wired by `test/support/test-app.ts` and by the `jobs --dry-run` CLI path — the
 * second implementation exists so the abstraction has a reason to be one.
 */
describe('FeatureFlags', () => {
  function config(overrides: Partial<Record<string, boolean>> = {}): ApiConfig {
    return {
      flags: {
        ledgerOwnsInvoices: false,
        ledgerOwnsFees: true,
        redactPanInLogs: true,
        ...overrides,
      },
    } as unknown as ApiConfig;
  }

  describe('flag-names', () => {
    it('lists exactly the three flags the repo has', () => {
      expect(ALL_FLAG_NAMES).toHaveLength(3);
    });

    it('recognises a real flag name', () => {
      expect(isFlagName('ledger_owns_invoices')).toBe(true);
      expect(isFlagName(FLAG_NAMES.REDACT_PAN_IN_LOGS)).toBe(true);
    });

    it('rejects a name nobody declared', () => {
      expect(isFlagName('enable_dark_mode')).toBe(false);
    });

    it('uses snake_case values matching the PostHog / env vocabulary', () => {
      for (const name of ALL_FLAG_NAMES) {
        expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });
  });

  describe('EnvFeatureFlags', () => {
    it('is a FeatureFlags', () => {
      expect(new EnvFeatureFlags(config())).toBeInstanceOf(FeatureFlags);
    });

    it('reads each flag off ApiConfig', () => {
      const flags = new EnvFeatureFlags(config());

      expect(flags.isEnabled(FLAG_NAMES.LEDGER_OWNS_INVOICES)).toBe(false);
      expect(flags.isEnabled(FLAG_NAMES.LEDGER_OWNS_FEES)).toBe(true);
      expect(flags.isEnabled(FLAG_NAMES.REDACT_PAN_IN_LOGS)).toBe(true);
    });

    it('has ledger_owns_invoices off — arc MIG is unfinished', () => {
      // Six months and counting. docs/adr/0012-invoice-cutover.md.
      expect(new EnvFeatureFlags(config()).isEnabled(FLAG_NAMES.LEDGER_OWNS_INVOICES)).toBe(false);
    });

    it('exposes isDisabled as the inverse', () => {
      const flags = new EnvFeatureFlags(config());

      expect(flags.isDisabled(FLAG_NAMES.LEDGER_OWNS_INVOICES)).toBe(true);
      expect(flags.isDisabled(FLAG_NAMES.LEDGER_OWNS_FEES)).toBe(false);
    });

    it('snapshots every flag', () => {
      const snapshot = new EnvFeatureFlags(config()).snapshot();

      expect(Object.keys(snapshot).sort()).toEqual([...ALL_FLAG_NAMES].sort());
    });

    it('does not observe a config mutation after construction', () => {
      const cfg = config();
      const flags = new EnvFeatureFlags(cfg);

      (cfg.flags as { ledgerOwnsInvoices: boolean }).ledgerOwnsInvoices = true;

      // Flags are read once at boot. A flag that changed mid-process would let one
      // request take the legacy arm and the next take the ledger arm, mid-cutover.
      expect(flags.isEnabled(FLAG_NAMES.LEDGER_OWNS_INVOICES)).toBe(false);
    });

    it('does not let a caller mutate the snapshot', () => {
      const flags = new EnvFeatureFlags(config());
      const snapshot = flags.snapshot();

      snapshot[FLAG_NAMES.LEDGER_OWNS_INVOICES] = true;

      expect(flags.isEnabled(FLAG_NAMES.LEDGER_OWNS_INVOICES)).toBe(false);
    });
  });

  describe('StaticFeatureFlags', () => {
    it('is a FeatureFlags', () => {
      expect(new StaticFeatureFlags()).toBeInstanceOf(FeatureFlags);
    });

    it('defaults every flag off', () => {
      const flags = new StaticFeatureFlags();

      for (const name of ALL_FLAG_NAMES) {
        expect(flags.isEnabled(name)).toBe(false);
      }
    });

    it('honours constructor overrides', () => {
      const flags = new StaticFeatureFlags({ [FLAG_NAMES.LEDGER_OWNS_INVOICES]: true });

      expect(flags.isEnabled(FLAG_NAMES.LEDGER_OWNS_INVOICES)).toBe(true);
      expect(flags.isEnabled(FLAG_NAMES.LEDGER_OWNS_FEES)).toBe(false);
    });

    it('can be flipped at runtime — the seam the MIG spec needs', () => {
      const flags = new StaticFeatureFlags();

      flags.set(FLAG_NAMES.LEDGER_OWNS_INVOICES, true);

      expect(flags.isEnabled(FLAG_NAMES.LEDGER_OWNS_INVOICES)).toBe(true);
    });

    it('snapshots every flag, like the env implementation', () => {
      expect(Object.keys(new StaticFeatureFlags().snapshot()).sort()).toEqual(
        [...ALL_FLAG_NAMES].sort(),
      );
    });
  });

  it('both implementations answer identically for the same inputs', () => {
    const env = new EnvFeatureFlags(config({ ledgerOwnsInvoices: true }));
    const stat = new StaticFeatureFlags({
      [FLAG_NAMES.LEDGER_OWNS_INVOICES]: true,
      [FLAG_NAMES.LEDGER_OWNS_FEES]: true,
      [FLAG_NAMES.REDACT_PAN_IN_LOGS]: true,
    });

    for (const name of ALL_FLAG_NAMES) {
      expect(stat.isEnabled(name)).toBe(env.isEnabled(name));
    }
  });
});
