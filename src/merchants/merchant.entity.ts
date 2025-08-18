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

  @Column({ name: 'payout_schedule', type: 'text', default: 'daily' })
  payoutSchedule!: PayoutSchedule;

  /** Funds availability in banking days. T+2 standard, T+7 for `high` risk. */
  @Column({ name: 'payout_delay_days', type: 'integer', default: 2 })
  payoutDelayDays!: number;

  @Column({ name: 'livemode', type: 'boolean', default: false })
  livemode!: boolean;

}
