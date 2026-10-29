/**
 * AdminMerchantsService — the back office's merchant screens (RFC platform-v2 §1). Cross-tenant
 * by construction: every caller is a staff principal and nothing here takes a merchant scope.
 *
 * It assembles; it does not decide. Onboarding decisions are `OnboardingService.decide`, status
 * changes are `MerchantsService.changeStatus`, and both already emit what the rest of the
 * platform listens for. The one rule that lives here is that the status route cannot be used to
 * skip review: a merchant still `pending_review` (or `rejected`) is moved by an onboarding
 * decision, never by "set status to active".
 */
import { Inject, Injectable } from '@nestjs/common';

import type {
  AdminMerchantDetail,
  AdminMerchantListQuery,
  AdminMerchantStatusRequest,
  AdminMerchantSummary,
  Balance,
  Merchant,
  MerchantId,
  Paginated,
} from '@payzeno/contracts';

import { ConflictException } from '../common/errors/api.exception';
import { MerchantNotFoundException } from '../common/errors/not-found.exceptions';
import { LedgerRejectedException, LedgerUnavailableException } from '../common/errors/upstream.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { resolveListQuery } from '../common/pagination/list-query.dto';
import { LedgerReadThroughService } from '../ledger/ledger-read-through.service';
import type { MerchantEntity } from '../merchants/merchant.entity';
import { MerchantRepository } from '../merchants/merchant.repository';
import { MerchantsService, toMerchantResponse } from '../merchants/merchants.service';
import { MerchantUserRepository } from '../merchants/users/merchant-user.repository';
import { OnboardingService, type StaffActor } from '../onboarding/onboarding.service';
import type { OnboardingDecision } from '../onboarding/state/onboarding.state-machine';

/** `merchant_user` lists are short (PAY-1902); the detail shows all of them. */
const DETAIL_USER_LIMIT = 100;

@Injectable()
export class AdminMerchantsService {
  constructor(
    private readonly merchants: MerchantRepository,
    private readonly users: MerchantUserRepository,
    private readonly merchantsService: MerchantsService,
    private readonly onboarding: OnboardingService,
    private readonly ledger: LedgerReadThroughService,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /** `GET /v1/admin/merchants`. */
  async list(query: AdminMerchantListQuery): Promise<Paginated<AdminMerchantSummary>> {
    const page = await this.merchants.searchForStaff(
      { status: query.status, onboardingState: query.onboarding_state, q: query.q },
      resolveListQuery(query),
    );

    const ids = page.data.map((merchant) => merchant.id);
    const [onboarding, owners] = await Promise.all([this.onboarding.rowsFor(ids), this.users.ownerEmailsFor(ids)]);

    return {
      data: page.data.map((merchant) => {
        const row = onboarding.get(merchant.id);
        return {
          object: 'admin_merchant_summary',
          merchant: toMerchantResponse(merchant),
          onboarding_state: row?.state ?? 'collecting',
          submitted_at: row?.submittedAt ? row.submittedAt.toISOString() : null,
          owner_email: owners.get(merchant.id) ?? null,
        };
      }),
      has_more: page.has_more,
      next_cursor: page.next_cursor,
    };
  }

  /** `GET /v1/admin/merchants/:merchantId`. */
  async detail(merchantId: MerchantId): Promise<AdminMerchantDetail> {
    const merchant = await this.require(merchantId);

    const [onboarding, users, bankAccounts, balances] = await Promise.all([
      this.onboarding.get(merchantId),
      this.users.listForMerchant(merchantId, DETAIL_USER_LIMIT),
      this.onboarding.bankAccountsFor(merchantId),
      this.balancesFor(merchant),
    ]);

    return {
      object: 'admin_merchant',
      merchant: toMerchantResponse(merchant),
      onboarding,
      users: users.map((user) => user.toUser()),
      bank_accounts: bankAccounts,
      balances,
    };
  }

  /** `POST /v1/admin/merchants/:merchantId/onboarding/{approve|reject|request-info}`. */
  async decide(
    merchantId: MerchantId,
    decision: OnboardingDecision,
    message: string | null,
    staff: StaffActor,
  ): Promise<AdminMerchantDetail> {
    await this.require(merchantId);
    await this.onboarding.decide(merchantId, decision, message, staff);
    return this.detail(merchantId);
  }

  /** `POST /v1/admin/merchants/:merchantId/status` — restrict, suspend, reinstate. */
  async changeStatus(
    merchantId: MerchantId,
    request: AdminMerchantStatusRequest,
    staffId: string,
  ): Promise<Merchant> {
    const merchant = await this.require(merchantId);

    if (merchant.status === 'pending_review' || merchant.status === 'rejected') {
      throw new ConflictException(
        `A ${merchant.status} merchant is moved by an onboarding decision, not by a status change`,
        { reason: 'onboarding_decision_required', status: merchant.status },
      );
    }

    return this.merchantsService.changeStatus(merchantId, request.status, request.reason, `staff:${staffId}`);
  }

  private async require(merchantId: MerchantId): Promise<MerchantEntity> {
    const merchant = await this.merchants.findById(merchantId);
    if (!merchant) throw new MerchantNotFoundException(merchantId);
    return merchant;
  }

  /**
   * The live balance in the default currency. A ledger that cannot answer degrades the detail
   * page to "balance unavailable" instead of taking the whole page down with it.
   */
  private async balancesFor(merchant: MerchantEntity): Promise<Balance[]> {
    try {
      return [await this.ledger.getBalance(merchant.id, merchant.defaultCurrency, true)];
    } catch (err) {
      if (err instanceof LedgerUnavailableException || err instanceof LedgerRejectedException) {
        this.logger.warn('admin.balance_unavailable', { merchant_id: merchant.id, error: err.message });
        return [];
      }
      throw err;
    }
  }
}
