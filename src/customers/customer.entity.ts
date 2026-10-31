/**
 * `customer` — RFC platform-v2 §5, migration platform-v2 money 1.
 *
 * A merchant's own customer: who pays, and which saved card pays by default. Scoped by merchant
 * and mode like every other merchant row — a test-mode customer's saved card can never pay a
 * live intent.
 */
import type { Customer, Metadata, PaymentMethodId } from '@payzeno/contracts';
import { Column, Entity, Index } from 'typeorm';

import { MerchantScopedEntity } from '../common/base/merchant-scoped.entity';

/** `cus_`. Minted through `IdFactory.opaque` until the prefix joins `API_ID_PREFIXES`. */
export const CUSTOMER_ID_PREFIX = 'cus_';

@Entity({ name: 'customer' })
@Index('ix_customer_merchant_created', ['merchantId', 'livemode', 'createdAt'])
export class CustomerEntity extends MerchantScopedEntity {
  /** `citext`: the lookup by email is case-insensitive without a lower(). */
  @Column({ type: 'citext', nullable: true })
  email!: string | null;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'text', name: 'default_payment_method_id', nullable: true })
  defaultPaymentMethodId!: PaymentMethodId | null;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  metadata!: Metadata;
}

export function toCustomer(row: CustomerEntity): Customer {
  return {
    id: row.id,
    object: 'customer',
    merchant_id: row.merchantId,
    email: row.email,
    name: row.name,
    default_payment_method_id: row.defaultPaymentMethodId,
    livemode: row.livemode,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
  };
}
