/**
 * `bank_account` — data-model.md §1.4. The payout destination.
 *
 * arc PCI §11.3: Payzeno never holds the digits. The browser posts the account number to the
 * vault, the vault returns a `bat_` token, and this row stores the token plus the
 * scheme-appropriate last-four values. `PayoutInitiator` in payzeno-ledger resolves the token
 * at the rail boundary, which is why `merchant.bank_account_verified` carries
 * `account_number_token` — the ledger holds an id it otherwise could not resolve.
 *
 * `chk_bank_account_scheme_fields` is a real check constraint and `assertSchemeFields()` is
 * its application-side twin: `aba` needs `routing_last_four`, `iban` needs `iban_last_four`
 * plus `bic`, `uk_sort_code` needs `sort_code_last_four`. The rails are not interchangeable —
 * `standard_ach`/`same_day_ach` require `aba`, `sepa` requires `iban`, `faster_payments`
 * requires `uk_sort_code`.
 */
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { currencyTransformer, trimmedCharTransformer } from '../../common/typeorm/minor-units.transformer';

import type {
  BankAccountScheme,
  BankAccountStatus,
  CurrencyCode,
  MerchantId,
} from '@payzeno/contracts';

import { MerchantScopedEntity } from '../../common/base/merchant-scoped.entity';
import { MerchantEntity } from '../merchant.entity';

@Entity({ name: 'bank_account' })
@Index('ix_bank_account_merchant_id', ['merchantId'])
@Index('pix_bank_account_default', ['merchantId', 'currency', 'livemode'], {
  unique: true,
  where: 'is_default',
})
export class BankAccountEntity extends MerchantScopedEntity {
  @ManyToOne(() => MerchantEntity, (merchant) => merchant.bankAccounts)
  @JoinColumn({ name: 'merchant_id' })
  merchant?: MerchantEntity;

  @Column({ name: 'country', type: 'char', length: 2, transformer: trimmedCharTransformer })
  country!: string;

  @Column({ name: 'currency', type: 'char', length: 3, transformer: currencyTransformer })
  currency!: CurrencyCode;

  @Column({ name: 'bank_name', type: 'text' })
  bankName!: string;

  @Column({ name: 'scheme', type: 'text' })
  scheme!: BankAccountScheme;

  /** Vault token, `bat_` prefixed. Never the number. */
  @Column({ name: 'account_number_token', type: 'text', select: false })
  accountNumberToken!: string;

  @Column({ name: 'last_four', type: 'char', length: 4, nullable: true })
  lastFour!: string | null;

  @Column({ name: 'routing_last_four', type: 'char', length: 4, nullable: true })
  routingLastFour!: string | null;

  @Column({ name: 'iban_last_four', type: 'char', length: 4, nullable: true })
  ibanLastFour!: string | null;

  @Column({ name: 'bic', type: 'varchar', length: 11, nullable: true })
  bic!: string | null;

  @Column({ name: 'sort_code_last_four', type: 'char', length: 4, nullable: true })
  sortCodeLastFour!: string | null;

  @Column({ name: 'status', type: 'text', default: 'new' })
  status!: BankAccountStatus;

  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault!: boolean;

  @Column({ name: 'account_holder_name', type: 'text' })
  accountHolderName!: string;

  /** Which payout rails this account can carry. `PayoutInitiator` re-checks it ledger-side. */
  supportedMethods(): string[] {
    switch (this.scheme) {
      case 'aba':
        return ['standard_ach', 'same_day_ach'];
      case 'iban':
        return ['sepa'];
      case 'uk_sort_code':
        return ['faster_payments'];
      default:
        return [];
    }
  }

  isPayable(): boolean {
    return this.status === 'validated';
  }

  toBankAccount(): {
    id: string;
    object: 'bank_account';
    merchant_id: MerchantId;
    country: string;
    currency: CurrencyCode;
    bank_name: string;
    scheme: BankAccountScheme;
    last_four: string;
    routing_last_four: string | null;
    iban_last_four: string | null;
    bic: string | null;
    sort_code_last_four: string | null;
    status: BankAccountStatus;
    is_default: boolean;
    livemode: boolean;
    created_at: string;
  } {
    return {
      id: this.id,
      object: 'bank_account',
      merchant_id: this.merchantId,
      country: this.country,
      currency: this.currency,
      bank_name: this.bankName,
      scheme: this.scheme,
      last_four: this.lastFour ?? '0000',
      routing_last_four: this.routingLastFour,
      iban_last_four: this.ibanLastFour,
      bic: this.bic,
      sort_code_last_four: this.sortCodeLastFour,
      status: this.status,
      is_default: this.isDefault,
      livemode: this.livemode,
      created_at: this.toIsoCreatedAt(),
    };
  }
}
