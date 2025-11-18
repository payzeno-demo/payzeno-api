/**
 * The production FeatureFlags. Values come off ApiConfig.flags, which came off `FLAG_*` env
 * vars — this class is the only reader of that config section.
 *
 * Flags are read once at boot, not per call. A flag that changes under a running process
 * means one request takes the legacy arm and the next takes the ledger arm mid-cutover, which
 * is exactly the failure mode docs/adr/0012-invoice-cutover.md is trying to avoid. Changing a
 * flag is a deploy.
 */
import { Inject, Injectable } from '@nestjs/common';

import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';

import { FeatureFlags } from './feature-flags';
import { FLAG_NAMES, type FlagName } from './flag-names';

@Injectable()
export class EnvFeatureFlags extends FeatureFlags {
  private readonly values: Record<FlagName, boolean>;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    super();
    this.values = {
      [FLAG_NAMES.LEDGER_OWNS_INVOICES]: config.flags.ledgerOwnsInvoices,
      [FLAG_NAMES.LEDGER_OWNS_FEES]: config.flags.ledgerOwnsFees,
      [FLAG_NAMES.REDACT_PAN_IN_LOGS]: config.flags.redactPanInLogs,
    };
  }

  isEnabled(flag: FlagName): boolean {
    return this.values[flag] === true;
  }

  snapshot(): Record<FlagName, boolean> {
    return { ...this.values };
  }
}
