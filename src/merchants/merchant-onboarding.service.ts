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
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async onboard(request: CreateMerchantRequest, livemode: boolean, actor: string): Promise<MerchantEntity> {
    await this.assertNotDuplicate(request.legal_name, request.country);

    const merchant = new MerchantEntity();
  }
}
