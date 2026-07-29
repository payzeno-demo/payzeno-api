/**
 * BankAccountsService — `extends BaseService<BankAccountEntity>`.
 *
 * Three rules, all of which exist because a payout that is wrong is a payout that comes back
 * three days later with a fee attached:
 *
 *   1. scheme ↔ currency. `sepa` is EUR, `faster_payments` is GBP, ACH is USD. A GBP account
 *      on the SEPA rail is a returned payout, not a validation error the merchant sees at the
 *      moment they can still fix it.
 *   2. scheme ↔ fields. `chk_bank_account_scheme_fields` in the database; the same check here
 *      so the merchant gets a `field_errors[]` and not a 23514.
 *   3. exactly one default PER CURRENCY (`pix_bank_account_default`, partial unique). Setting
 *      a new default clears the old one in the same transaction, or the index rejects it.
 *
 * The `merchant.bank_account_verified` emit is what gives payzeno-ledger a
 * `bank_account_projection` row. Without it the ledger holds a `payout.bank_account_id` it
 * cannot resolve and `PayoutInitiator.initiate` has no account number token to hand the rail.
 */
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';

import type {
  BankAccount,
  BankAccountScheme,
  CreateBankAccountRequest,
  CurrencyCode,
  ListQuery,
  MerchantId,
  Paginated,
} from '@payzeno/contracts';

import { BaseService } from '../../common/base/base.service';
import type { MerchantScope } from '../../common/base/merchant-scoped.entity';
import { ValidationException } from '../../common/errors/api.exception';
import { ResourceNotFoundException } from '../../common/errors/not-found.exceptions';
import { IdFactory } from '../../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { currentCorrelationId } from '../../common/logging/request-context';
import { PayzenoRepository } from '../../common/persistence/payzeno.repository';
import { TransactionManager } from '../../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../../common/time/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '../../events/publisher';

import { BankAccountEntity } from './bank-account.entity';

/** Which currency each rail actually settles in. domain-model.md §9. */
const CURRENCY_BY_SCHEME: Readonly<Record<BankAccountScheme, CurrencyCode[]>> = {
  aba: ['USD'],
  iban: ['EUR'],
  uk_sort_code: ['GBP'],
};

@Injectable()
export class BankAccountRepository extends PayzenoRepository<BankAccountEntity> {
  constructor(dataSource: DataSource) {
    super(BankAccountEntity, dataSource.createEntityManager());
  }

  protected get alias(): string {
    return 'bank_account';
  }

  findDefault(
    merchantId: MerchantId,
    currency: CurrencyCode,
    livemode: boolean,
  ): Promise<BankAccountEntity | null> {
    return this.createQueryBuilder('bank_account')
      .where('bank_account.merchant_id = :merchantId', { merchantId })
      .andWhere('bank_account.currency = :currency', { currency })
      .andWhere('bank_account.livemode = :livemode', { livemode })
      .andWhere('bank_account.is_default = true')
      .getOne();
  }

  async clearDefault(
    merchantId: MerchantId,
    currency: CurrencyCode,
    livemode: boolean,
    manager: EntityManager,
  ): Promise<void> {
    await manager
      .getRepository(BankAccountEntity)
      .createQueryBuilder()
      .update()
      .set({ isDefault: false })
      .where('merchant_id = :merchantId', { merchantId })
      .andWhere('currency = :currency', { currency })
      .andWhere('livemode = :livemode', { livemode })
      .andWhere('is_default = true')
      .execute();
  }

  async markDefault(bankAccountId: string, manager: EntityManager): Promise<void> {
    await manager
      .getRepository(BankAccountEntity)
      .createQueryBuilder()
      .update()
      .set({ isDefault: true })
      .where('id = :bankAccountId', { bankAccountId })
      .execute();
  }
}

@Injectable()
export class BankAccountsService extends BaseService<BankAccountEntity> {
  constructor(
    private readonly accounts: BankAccountRepository,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(accounts, logger);
  }

  get entityName(): string {
    return 'bank_account';
  }

  async list(scope: MerchantScope, query: ListQuery): Promise<Paginated<BankAccount>> {
    const page = await this.paginate(query, scope);
    return {
      data: page.data.map((account) => account.toBankAccount()),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
    };
  }

  async get(scope: MerchantScope, bankAccountId: string): Promise<BankAccount> {
    const account = await this.findOneOrThrow(bankAccountId, scope);
    return account.toBankAccount();
  }

  /** Internal read for `InternalController#getBankAccount` — the ledger's stale-projection fallback. */
  async getForInternal(bankAccountId: string): Promise<BankAccountEntity> {
    const account = await this.accounts.findOne({ where: { id: bankAccountId } });
    if (!account) throw new ResourceNotFoundException('bank_account', bankAccountId);
    return account;
  }

  async create(scope: MerchantScope, request: CreateBankAccountRequest): Promise<BankAccount> {
    this.assertSchemeMatchesCurrency(request.scheme, request.currency);

    const account = this.build(scope, request);

    const saved = await this.transactions.runInTransaction(async (manager) => {
      if (account.isDefault) {
        await this.accounts.clearDefault(scope.merchantId, account.currency, scope.livemode, manager);
      }

      await this.accounts.insertMapped(account, manager);

      await this.events.publish(
        'merchant.bank_account_verified',
        {
          merchant_id: account.merchantId,
          bank_account_id: account.id,
          country: account.country,
          currency: account.currency,
          scheme: account.scheme,
          account_number_token: account.accountNumberToken,
          routing_last_four: account.routingLastFour,
          iban_last_four: account.ibanLastFour,
          bic: account.bic,
          sort_code_last_four: account.sortCodeLastFour,
          status: account.status,
          is_default: account.isDefault,
          verified_at: this.clock.nowIso(),
        },
        {
          merchantId: account.merchantId,
          correlationId: currentCorrelationId(),
          causationId: null,
          livemode: account.livemode,
          occurredAt: this.clock.nowIso(),
        },
      );

      return account;
    });

    this.logger.info('bank_account.created', {
      merchant_id: scope.merchantId,
      bank_account_id: saved.id,
      scheme: saved.scheme,
      currency: saved.currency,
    });

    return saved.toBankAccount();
  }

  /**
   * `POST /v1/bank-accounts/:bankAccountId/default`. Clear-then-set inside one transaction:
   * `pix_bank_account_default` is a partial UNIQUE index and doing it the other way round
   * fails on the second statement every time.
   */
  async makeDefault(scope: MerchantScope, bankAccountId: string): Promise<BankAccount> {
    const account = await this.findOneOrThrow(bankAccountId, scope);

    if (!account.isPayable()) {
      throw new ValidationException('Only a validated bank account can be the default', [
        { path: 'status', code: 'not_validated', message: `account is '${account.status}'` },
      ]);
    }

    await this.transactions.runInTransaction(async (manager) => {
      await this.accounts.clearDefault(scope.merchantId, account.currency, scope.livemode, manager);
      await this.accounts.markDefault(account.id, manager);
    });

    account.isDefault = true;
    return account.toBankAccount();
  }

  private build(scope: MerchantScope, request: CreateBankAccountRequest): BankAccountEntity {
    const account = new BankAccountEntity();
    const now = this.clock.now();

    account.id = this.ids.bankAccountId();
    account.merchantId = scope.merchantId;
    account.livemode = scope.livemode;
    account.country = request.country.toUpperCase();
    account.currency = request.currency;
    account.scheme = request.scheme;
    account.accountNumberToken = request.bank_account_token;
    account.accountHolderName = request.account_holder_name.trim();
    account.bankName = 'Pending validation';
    account.status = 'new';
    account.isDefault = request.is_default ?? false;
    account.createdAt = now;
    account.updatedAt = now;

    // The vault returns the last-four values with the token; until the validation callback
    // lands they are null, and `toBankAccount()` renders '0000' rather than leaking undefined.
    account.lastFour = null;
    account.routingLastFour = null;
    account.ibanLastFour = null;
    account.bic = null;
    account.sortCodeLastFour = null;

    return account;
  }

  private assertSchemeMatchesCurrency(scheme: BankAccountScheme, currency: CurrencyCode): void {
    const allowed = CURRENCY_BY_SCHEME[scheme];

    if (!allowed.includes(currency)) {
      throw new ValidationException(`A ${scheme} account cannot settle ${currency}`, [
        {
          path: 'scheme',
          code: 'scheme_currency_mismatch',
          message: `${scheme} settles ${allowed.join(', ')}`,
        },
      ]);
    }
  }
}
