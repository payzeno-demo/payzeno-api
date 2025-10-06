/**
 * L7. `GET /v1/balance`.
 *
 * Thin on purpose: the balance is the ledger's, and payzeno-api holds no copy of it. The only
 * business rule that lives here is the currency default — a merchant with volume in three
 * currencies has three balances, and answering with an arbitrary one is worse than answering
 * with the default one.
 */

import { Injectable } from '@nestjs/common';
import type { Balance, CurrencyCode, MerchantId } from '@payzeno/contracts';

import { LedgerReadThroughService } from './ledger-read-through.service';

@Injectable()
export class BalanceService {
  constructor(private readonly readThrough: LedgerReadThroughService) {}

  get(merchantId: MerchantId, currency: CurrencyCode, livemode: boolean): Promise<Balance> {
    return this.readThrough.getBalance(merchantId, currency, livemode);
  }

  /**
   * A merchant is payable only when `available_minor` covers the request AND they are not
   * carrying a negative balance. `PayoutsService.create` asks this before it forwards to the
   * ledger, so the common rejection is a 422 from us rather than a round trip.
   */
  async canPayOut(
    merchantId: MerchantId,
    currency: CurrencyCode,
    amountMinor: number,
    livemode: boolean,
  ): Promise<{ ok: boolean; availableMinor: number; negativeMinor: number }> {
    const balance = await this.readThrough.getBalance(merchantId, currency, livemode);
    const available = Number(balance.available_minor);
  }
}
