/**
 * MerchantOnboardingService — L6. The multi-aggregate write behind `POST /v1/merchants`.
 *
 * Chain E of the blueprint, and the only cross-repo WRITE payzeno-api performs during a
 * request:
 *
 *   MerchantsController.create  @StaffOnly() @Idempotent() @AuditLog('merchant.create')
 *   → MerchantsService.create
 *   → MerchantOnboardingService.onboard
 *   → TransactionManager.runInTransaction
 *        ├─ MerchantRepository.insert
 *        ├─ OutboxEventPublisher.publish('merchant.created')
 *        └─ LedgerHttpClient.bootstrapAccounts   POST /internal/v1/accounts/bootstrap
 *
 * The bootstrap call is inside the transaction on purpose, and it is a real tradeoff that has
 * been argued twice in review. The alternative — bootstrap after commit — leaves a merchant
 * that exists here and has no chart of accounts there, and the first authorisation for that
 * merchant then fails in the ledger with `account_not_found`, at which point the money path is
 * where you find out. `AccountResolver.get_or_create` is idempotent under
 * `uq_account_merchant_type_currency_livemode`, so a retry is free; an orphaned merchant is
 * not. If the ledger is down, onboarding fails loudly and the staff operator retries with the
 * same `Idempotency-Key`. — dhotfix, PAY-1284
 */
import { Inject, Injectable } from '@nestjs/common';

import type { CreateMerchantRequest, CurrencyCode, MerchantId } from '@payzeno/contracts';

import { ValidationException } from '../common/errors/api.exception';
import { LedgerUnavailableException } from '../common/errors/upstream.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { currentCorrelationId } from '../common/logging/request-context';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { EVENT_PUBLISHER, type EventPublisher } from '../events/publisher';
import { LedgerHttpClient } from '../ledger/ledger-http.client';

import { MerchantEntity } from './merchant.entity';
import { MerchantRepository } from './merchant.repository';

/** Defaults for a merchant nobody has priced yet. data-model.md §1.1 column defaults. */
const DEFAULTS = {
  platformFeeBps: 290,
  platformFeeFixedMinor: 30,
  payoutDelayDays: 2,
  settlementToleranceMinor: 100,
} as const;

@Injectable()
export class MerchantOnboardingService {
  constructor(
    private readonly merchants: MerchantRepository,
    private readonly transactions: TransactionManager,
    private readonly ledger: LedgerHttpClient,
    private readonly ids: IdFactory,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async onboard(request: CreateMerchantRequest, livemode: boolean, actor: string): Promise<MerchantEntity> {
    await this.assertNotDuplicate(request.legal_name, request.country);

    const merchant = this.build(request, livemode);

    return this.transactions.runInTransaction(async (manager) => {
      await this.merchants.insertMapped(merchant, manager);

      await this.events.publish(
        'merchant.created',
        {
          merchant_id: merchant.id,
          legal_name: merchant.legalName,
          display_name: merchant.displayName,
          country: merchant.country,
          default_currency: merchant.defaultCurrency,
          mcc: merchant.mcc,
          status: merchant.status,
          risk_tier: merchant.riskTier,
          payout_schedule: merchant.payoutSchedule,
          pricing_model: merchant.pricingModel,
          reserve_bps: merchant.reserveBps,
          reserve_hold_days: merchant.reserveHoldDays,
          payout_delay_days: merchant.payoutDelayDays,
          settlement_tolerance_minor: merchant.settlementToleranceMinor,
          capture_at_settlement: merchant.captureAtSettlement,
          platform_fee_bps: merchant.platformFeeBps,
          platform_fee_fixed_minor: merchant.platformFeeFixedMinor,
          created_at: merchant.createdAt.toISOString(),
        },
        {
          merchantId: merchant.id,
          correlationId: currentCorrelationId(),
          causationId: null,
          livemode: merchant.livemode,
          occurredAt: this.clock.nowIso(),
        },
      );

      await this.bootstrapLedgerAccounts(merchant.id, merchant.defaultCurrency, merchant.livemode);

      this.logger.info('merchant.onboarded', {
        merchant_id: merchant.id,
        country: merchant.country,
        currency: merchant.defaultCurrency,
        livemode: merchant.livemode,
        actor,
      });

      return merchant;
    });
  }

  /**
   * `uq_merchant_legal_name_country` would catch this as a 23505, but the mapped message
   * ("conflict") tells a staff operator nothing. Onboarding the same company twice with
   * different capitalisation is the duplicate that actually happens.
   */
  private async assertNotDuplicate(legalName: string, country: string): Promise<void> {
    const existing = await this.merchants.findByLegalName(legalName, country);

    if (existing) {
      throw new ValidationException('A merchant with this legal name already exists in this country', [
        { path: 'legal_name', code: 'duplicate', message: `already onboarded as ${existing.id}` },
      ]);
    }
  }

  private build(request: CreateMerchantRequest, livemode: boolean): MerchantEntity {
    const merchant = new MerchantEntity();
    const now = this.clock.now();

    merchant.id = this.ids.merchantId();
    merchant.legalName = request.legal_name.trim();
    merchant.displayName = request.display_name.trim();
    merchant.country = request.country.toUpperCase();
    merchant.defaultCurrency = request.default_currency;
    merchant.mcc = request.mcc;
    merchant.status = 'pending_review';
    merchant.riskTier = 'standard';
    merchant.payoutSchedule = request.payout_schedule ?? 'daily';
    merchant.pricingModel = 'blended';
    merchant.reserveBps = 0;
    merchant.reserveHoldDays = 0;
    merchant.platformFeeBps = DEFAULTS.platformFeeBps;
    merchant.platformFeeFixedMinor = DEFAULTS.platformFeeFixedMinor;
    merchant.payoutDelayDays = DEFAULTS.payoutDelayDays;
    merchant.settlementToleranceMinor = DEFAULTS.settlementToleranceMinor;
    merchant.captureAtSettlement = false;
    merchant.statementDescriptor = null;
    merchant.livemode = livemode;
    merchant.metadata = request.metadata ?? {};
    merchant.createdAt = now;
    merchant.updatedAt = now;

    return merchant;
  }

  /**
   * `POST /internal/v1/accounts/bootstrap`. Idempotent ledger-side, so the retry a staff
   * operator performs with the same Idempotency-Key does not create a second chart.
   */
  private async bootstrapLedgerAccounts(
    merchantId: MerchantId,
    currency: CurrencyCode,
    livemode: boolean,
  ): Promise<void> {
    try {
      const result = await this.ledger.bootstrapAccounts(merchantId, currency, livemode);
      this.logger.debug('merchant.accounts_bootstrapped', {
        merchant_id: merchantId,
        created: result.created,
      });
    } catch (err) {
      if (err instanceof LedgerUnavailableException) {
        // Rethrow so the transaction rolls back: better no merchant than a merchant with no
        // accounts. The staff console shows "ledger unavailable, retry" and the retry works.
        this.logger.error('merchant.bootstrap_failed', err, { merchant_id: merchantId });
      }
      throw err;
    }
  }
}
