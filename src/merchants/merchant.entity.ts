/**
 * `merchant` — data-model.md §1.1.
 *
 * Extends `BaseEntity`, not `MerchantScopedEntity`: the merchant IS the tenant, so its scope
 * column is `id`, not `merchant_id`. `MerchantRepository` overrides `scopeColumn` to say so.
 *
 * `capture_at_settlement` is a COLUMN, not a feature flag (domain-model.md §1). payzeno-api
 * reads it here; payzeno-ledger reads `merchant_projection.capture_at_settlement`, and the
 * ONLY thing that ever sets the ledger's copy is the `merchant.updated` event emitted by
 * `MerchantsService.update`. It is also the eleven-merchant blast radius of arc INC — a
 * deferred-capture merchant is one whose money moves at settlement time, which is precisely
 * where the ledger double-posted.
 *
 * The fee columns are the merchant's *pricing*, not Payzeno's revenue recognition: the
 * acquirer's `fee_minor` off a settlement line is an expense and never touches
 * `platform_fee_bps`. domain-model.md §7.
 */
import { Column, Entity, Index, OneToMany } from 'typeorm';

import type {
  BasisPoints,
  CurrencyCode,
  MerchantStatus,
  Metadata,
  MinorUnits,
  PayoutSchedule,
  PricingModel,
  RiskTier,
} from '@payzeno/contracts';

import { BaseEntity } from '../common/base/base.entity';
import { currencyTransformer, requiredMinorUnitsTransformer, trimmedCharTransformer } from '../common/typeorm/minor-units.transformer';

import { ApiKeyEntity } from './api-keys/api-key.entity';
import { BankAccountEntity } from './bank-accounts/bank-account.entity';
import { MerchantUserEntity } from './users/merchant-user.entity';

@Entity({ name: 'merchant' })
@Index('uq_merchant_legal_name_country', ['legalName', 'country'], { unique: true })
@Index('ix_merchant_status', ['status'])
@Index('pix_merchant_capture_at_settlement', ['id'], { where: 'capture_at_settlement' })
export class MerchantEntity extends BaseEntity {
  @Column({ name: 'legal_name', type: 'text' })
  legalName!: string;

  @Column({ name: 'default_currency', type: 'char', length: 3, transformer: currencyTransformer })
  defaultCurrency!: CurrencyCode;

  @Column({ name: 'status', type: 'text', default: 'pending_review' })
  status!: MerchantStatus;

  /** 4-digit merchant category code. 3000-3999 / 7011 / 7512 are the 30-day-auth set. */
  @Column({ name: 'mcc', type: 'char', length: 4 })
  mcc!: string;

  @Column({ name: 'payout_schedule', type: 'text', default: 'daily' })
  payoutSchedule!: PayoutSchedule;

  /** Drives `reserve_hold.release_on` in the ledger. 0 = no rolling reserve. */
  @Column({ name: 'reserve_hold_days', type: 'integer', default: 0 })
  reserveHoldDays!: number;

  @Column({ name: 'platform_fee_fixed_minor', type: 'bigint', default: 30, transformer: requiredMinorUnitsTransformer })
  platformFeeFixedMinor!: MinorUnits;

  /** Funds availability in banking days. T+2 standard, T+7 for `high` risk. */
  @Column({ name: 'payout_delay_days', type: 'integer', default: 2 })
  payoutDelayDays!: number;

  @Column({ name: 'capture_at_settlement', type: 'boolean', default: false })
  captureAtSettlement!: boolean;

  @Column({ name: 'livemode', type: 'boolean', default: false })
  livemode!: boolean;

  @Column({ name: 'metadata', type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Metadata;

  @OneToMany(() => ApiKeyEntity, (key) => key.merchant)
  apiKeys?: ApiKeyEntity[];

  @OneToMany(() => BankAccountEntity, (account) => account.merchant)
  bankAccounts?: BankAccountEntity[];

  /** May this merchant take new payments? `restricted` still can — it just cannot pay out. */
  canCharge(): boolean {
    return this.status === 'active' || this.status === 'restricted' || this.status === 'pending_review';
  }

  /** `restricted` is exactly "may charge, may not receive payouts". domain-model.md §1. */
  canPayOut(): boolean {
    return this.status === 'active';
  }

  /**
   * Auth validity. The schemes grant 30 days on travel / lodging / car rental precisely
   * because capture happens at return rather than at booking, and `capture_at_settlement`
   * targets that same MCC set — a flat 7-day expiry would void the holds the feature depends
   * on. `ChargeExpiryPolicy` is the one that applies this.
   */
  hasExtendedAuthWindow(): boolean {
    const code = Number.parseInt(this.mcc, 10);
    return (code >= 3000 && code <= 3999) || code === 7011 || code === 7512;
  }
}
