/**
 * `review` — a payment held by Payzeno's platform risk rules. RFC platform-v2 §8, migration
 * platform-v2 money 3.
 *
 * The authorisation stays uncaptured while the review is `open`. A Payzeno risk analyst closes
 * it: `approved` captures, `declined` voids. Merchants can read a review; they cannot act on it.
 */
import type {
  ChargeId,
  CurrencyCode,
  PaymentIntentId,
  Review,
  ReviewStatus,
  RiskRule,
  StaffUserId,
} from '@payzeno/contracts';
import { Column, Entity, Index } from 'typeorm';

import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import {
  currencyTransformer,
  requiredMinorUnitsTransformer,
  trimmedCharTransformer,
} from '../common/typeorm/minor-units.transformer';

/** `rv_`. Minted through `IdFactory.opaque` until the prefix joins `API_ID_PREFIXES`. */
export const REVIEW_ID_PREFIX = 'rv_';

@Entity({ name: 'review' })
@Index('ix_review_merchant_created', ['merchantId', 'livemode', 'createdAt'])
export class ReviewEntity extends MerchantScopedEntity {
  @Column({ type: 'text', name: 'payment_intent_id' })
  paymentIntentId!: PaymentIntentId;

  @Column({ type: 'text', name: 'charge_id' })
  chargeId!: ChargeId;

  @Column({ type: 'text', default: 'open' })
  status!: ReviewStatus;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  rules!: RiskRule[];

  @Column({ type: 'smallint', name: 'risk_score', default: 0 })
  riskScore!: number;

  @Column({ type: 'bigint', name: 'amount_minor', transformer: requiredMinorUnitsTransformer })
  amountMinor!: number;

  @Column({ type: 'char', length: 3, transformer: currencyTransformer })
  currency!: CurrencyCode;

  @Column({ type: 'char', length: 2, name: 'ip_country', nullable: true, transformer: trimmedCharTransformer })
  ipCountry!: string | null;

  @Column({ type: 'char', length: 2, name: 'card_country', nullable: true, transformer: trimmedCharTransformer })
  cardCountry!: string | null;

  @Column({ type: 'timestamptz', name: 'opened_at' })
  openedAt!: Date;

  @Column({ type: 'timestamptz', name: 'closed_at', nullable: true })
  closedAt!: Date | null;

  @Column({ type: 'text', name: 'closed_by', nullable: true })
  closedBy!: StaffUserId | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;
}

export function toReview(row: ReviewEntity): Review {
  return {
    id: row.id,
    object: 'review',
    merchant_id: row.merchantId,
    payment_intent_id: row.paymentIntentId,
    charge_id: row.chargeId,
    status: row.status,
    rules: row.rules,
    risk_score: row.riskScore,
    amount_minor: Number(row.amountMinor),
    currency: row.currency,
    ip_country: row.ipCountry,
    card_country: row.cardCountry,
    opened_at: row.openedAt.toISOString(),
    closed_at: row.closedAt ? row.closedAt.toISOString() : null,
    closed_by: row.closedBy,
    note: row.note,
    livemode: row.livemode,
  };
}
