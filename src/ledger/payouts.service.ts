/**
 * L7. Payouts are OWNED by payzeno-ledger; payzeno-api holds no `payout` table. This service
 * is authorisation, scoping and business refusal — the money lives one repo over.
 *
 * RFC platform-v2 §7: a payout may leave a balance in one currency for a bank account in
 * another; the ledger converts and reports `source_amount_minor`, `source_currency` and
 * `fx_rate`. Nothing here compares the payout currency with the account's — that is the
 * ledger's to price, and it is not a refusal any more. Those three fields are passed through
 * as the ledger sent them, null when it sent nothing (a same-currency payout, or a ledger that
 * predates conversion).
 *
 * Two refusals happen here rather than in the ledger, because they are merchant-status
 * decisions and the merchant row is ours:
 *  - a `restricted` merchant may charge but may NOT receive payouts (domain-model.md §1);
 *  - a merchant carrying a negative balance cannot pull funds out on top of it.
 *
 * ### Why `MerchantsService` is resolved through `ModuleRef`
 *
 * `MerchantsModule` imports `LedgerModule` (it needs `bootstrapAccounts` during onboarding),
 * so `LedgerModule` cannot import `MerchantsModule` back. Rather than duplicate the merchant
 * read here, the dependency is resolved non-strictly at `onModuleInit` — the same pattern the
 * event consumers use, for the same reason. docs/adr/0009-event-consumer-wiring.md.
 */

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { CreatePayoutRequest, MerchantId, Paginated, Payout, PayoutId } from '@payzeno/contracts';

import { MerchantRestrictedException } from '../common/errors/business.exceptions';
import { MerchantsService } from '../merchants/merchants.service';

import { BalanceService } from './balance.service';
import { LedgerReadThroughService } from './ledger-read-through.service';
import type { PayoutListQuery } from './ledger.types';

@Injectable()
export class PayoutsService implements OnModuleInit {
  private merchants!: MerchantsService;

  constructor(
    private readonly readThrough: LedgerReadThroughService,
    private readonly balances: BalanceService,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.merchants = this.moduleRef.get(MerchantsService, { strict: false });
  }

  async list(merchantId: MerchantId, query: Omit<PayoutListQuery, 'merchant_id'>): Promise<Paginated<Payout>> {
    const page = await this.readThrough.listPayouts(merchantId, query);
    return { ...page, data: page.data.map(withConversion) };
  }

  async get(merchantId: MerchantId, payoutId: PayoutId): Promise<Payout> {
    return withConversion(await this.readThrough.getPayout(merchantId, payoutId));
  }

  async create(
    merchantId: MerchantId,
    request: CreatePayoutRequest,
    idempotencyKey: string,
    livemode: boolean,
  ): Promise<Payout> {
    const merchant = await this.merchants.getById(merchantId);

    if (merchant.status !== 'active') {
      throw new MerchantRestrictedException(merchantId, merchant.status, 'receive payouts');
    }

    if (request.amount_minor !== undefined) {
      const check = await this.balances.canPayOut(merchantId, request.currency, request.amount_minor, livemode);
      if (!check.ok) {
        throw new MerchantRestrictedException(
          merchantId,
          merchant.status,
          check.negativeMinor > 0
            ? 'receive payouts while carrying a negative balance'
            : `receive a payout above its available balance of ${check.availableMinor}`,
        );
      }
    }

    return withConversion(
      await this.readThrough.createPayout(
        {
          merchant_id: merchantId,
          amount_minor: request.amount_minor,
          currency: request.currency,
          bank_account_id: request.bank_account_id,
          method: request.method,
          statement_descriptor: request.statement_descriptor,
        },
        idempotencyKey,
      ),
    );
  }

  async cancel(merchantId: MerchantId, payoutId: PayoutId): Promise<Payout> {
    return withConversion(await this.readThrough.cancelPayout(merchantId, payoutId));
  }

  /** `GET /v1/reporting/summary` fills `next_payout` from this. */
  async nextScheduled(merchantId: MerchantId): Promise<Payout | null> {
    const page = await this.readThrough.listPayouts(merchantId, { status: 'scheduled', limit: 1 });
    return page.data[0] ? withConversion(page.data[0]) : null;
  }
}

/**
 * The §7 conversion fields, present on every payout: as the ledger sent them, or null. The
 * contract makes them non-optional; a ledger response without them would otherwise reach the
 * console with the keys missing rather than null.
 */
export function withConversion(payout: Payout): Payout {
  return {
    ...payout,
    source_amount_minor: payout.source_amount_minor ?? null,
    source_currency: payout.source_currency ?? null,
    fx_rate: payout.fx_rate ?? null,
  };
}
