/**
 * `merchant_onboarding` — one row per merchant: where its KYC review stands, and what it has
 * told us about itself (RFC platform-v2 §3, migration 1731200000000).
 *
 * The profile and the representative are stored as the merchant last sent them (partial jsonb)
 * and normalised to the contract's all-keys-present shape on the way out, so a field the
 * contract grows later reads as `null` on old rows instead of `undefined`.
 */
import { Column, Entity, Index } from 'typeorm';

import type {
  BusinessProfile,
  MerchantId,
  OnboardingState,
  Representative,
} from '@payzeno/contracts';

import { BaseEntity } from '../common/base/base.entity';

const EMPTY_PROFILE: BusinessProfile = {
  business_type: null,
  website: null,
  product_description: null,
  support_email: null,
  address_line1: null,
  city: null,
  postal_code: null,
  registration_number: null,
};

const EMPTY_REPRESENTATIVE: Representative = {
  full_name: null,
  date_of_birth: null,
  email: null,
};

@Entity({ name: 'merchant_onboarding' })
@Index('uq_merchant_onboarding_merchant', ['merchantId'], { unique: true })
@Index('ix_merchant_onboarding_state_submitted', ['state', 'submittedAt'])
export class OnboardingEntity extends BaseEntity {
  @Column({ name: 'merchant_id', type: 'text' })
  merchantId!: MerchantId;

  @Column({ name: 'state', type: 'text', default: 'collecting' })
  state!: OnboardingState;

  @Column({ name: 'business_profile', type: 'jsonb', default: () => "'{}'::jsonb" })
  businessProfile!: Partial<BusinessProfile>;

  @Column({ name: 'representative', type: 'jsonb', default: () => "'{}'::jsonb" })
  representative!: Partial<Representative>;

  /** Set by staff on request-info and reject (and optionally approve); shown verbatim. */
  @Column({ name: 'staff_message', type: 'text', nullable: true })
  staffMessage!: string | null;

  @Column({ name: 'submitted_at', type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  /** `stf_` of the operator who made the last decision. */
  @Column({ name: 'decided_by', type: 'text', nullable: true })
  decidedBy!: string | null;

  profile(): BusinessProfile {
    return { ...EMPTY_PROFILE, ...this.businessProfile };
  }

  rep(): Representative {
    return { ...EMPTY_REPRESENTATIVE, ...this.representative };
  }
}
