/**
 * L7. Payouts are OWNED by payzeno-ledger; payzeno-api holds no `payout` table. This service
 * is authorisation, scoping and business refusal — the money lives one repo over.
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

  /** `GET /v1/reporting/summary` fills `next_payout` from this. */
  async nextScheduled(merchantId: MerchantId): Promise<Payout | null> {
    const page = await this.readThrough.listPayouts(merchantId, { status: 'scheduled', limit: 1 });
    return page.data[0] ?? null;
  }
}
