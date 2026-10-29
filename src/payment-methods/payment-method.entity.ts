/**
 * `payment_method` — a saved card. RFC platform-v2 §5, migration platform-v2 money 1.
 *
 * `vault_token` is the reusable `pmt_` token the vault resolves on every authorisation. It is
 * the only card handle stored, and it never leaves payzeno-api: `toPaymentMethod` has no field
 * for it, and every other surface names the card by `pm_` id. `fingerprint` is the vault's
 * keyed hash of the PAN — what makes "save this card" idempotent per customer.
 */
import type { CardBrand, CardFunding, CardSummary, CustomerId, PaymentMethod } from '@payzeno/contracts';
import { Column, Entity, Index } from 'typeorm';

import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';
import { trimmedCharTransformer } from '../common/typeorm/minor-units.transformer';

/** `pm_`. Minted through `IdFactory.opaque` until the prefix joins `API_ID_PREFIXES`. */
export const PAYMENT_METHOD_ID_PREFIX = 'pm_';

@Entity({ name: 'payment_method' })
@Index('ix_payment_method_customer', ['customerId', 'createdAt'])
export class PaymentMethodEntity extends MerchantScopedEntity {
  @Column({ type: 'text', name: 'customer_id' })
  customerId!: CustomerId;

  /** Never serialised. See the header. */
  @Column({ type: 'text', name: 'vault_token' })
  vaultToken!: string;

  @Column({ type: 'text' })
  fingerprint!: string;

  @Column({ type: 'enum', enum: ['visa', 'mastercard', 'amex', 'discover'], enumName: 'card_brand', name: 'card_brand' })
  cardBrand!: CardBrand;

  @Column({ type: 'char', length: 4, name: 'card_last_four' })
  cardLastFour!: string;

  @Column({ type: 'smallint', name: 'card_exp_month' })
  cardExpMonth!: number;

  @Column({ type: 'smallint', name: 'card_exp_year' })
  cardExpYear!: number;

  @Column({ type: 'char', length: 2, name: 'card_country', nullable: true, transformer: trimmedCharTransformer })
  cardCountry!: string | null;

  @Column({
    type: 'enum',
    enum: ['credit', 'debit', 'prepaid', 'unknown'],
    enumName: 'card_funding',
    name: 'card_funding',
    default: 'unknown',
  })
  cardFunding!: CardFunding;

  /** Soft delete: intents and subscriptions keep pointing at the row for their history. */
  @Column({ type: 'timestamptz', name: 'detached_at', nullable: true })
  detachedAt!: Date | null;

  card(): CardSummary {
    return {
      brand: this.cardBrand,
      last_four: this.cardLastFour,
      exp_month: this.cardExpMonth,
      exp_year: this.cardExpYear,
      country: this.cardCountry,
      funding: this.cardFunding,
    };
  }
}

export function toPaymentMethod(row: PaymentMethodEntity): PaymentMethod {
  return {
    id: row.id,
    object: 'payment_method',
    customer_id: row.customerId,
    card: row.card(),
    livemode: row.livemode,
    created_at: row.createdAt.toISOString(),
  };
}
