/**
 * RiskEvaluationService — the trailing-30-day dispute rate, and what it does to a merchant.
 *
 * Driven nightly by `RiskEvaluationJob` (`0 4 * * *`). Per merchant:
 *
 *   ChargeRepository.countCapturedSince + DisputeRepository.countOpenedSince
 *     → DisputeRateCalculator.calculate
 *     → over 100 bps  → MerchantsService.restrictForRisk  → merchant.status_changed
 *     → under 60 bps and currently restricted → reinstate
 *
 * `restricted` means "may charge, may not receive payouts" (domain-model.md §1). That is the
 * whole point of the status: stopping charges on a live merchant because of a dispute rate is
 * a business decision a human makes, but holding the money until they explain themselves is
 * not, and holding the money is what actually limits the loss.
 *
 * The counts are read through the two repositories rather than a joined query. They are in
 * different aggregates and the numbers are small; a nightly job doing two index scans per
 * merchant is not the thing to optimise.
 */
import { Inject, Injectable } from '@nestjs/common';

import type { MerchantId } from '@payzeno/contracts';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { CLOCK, type Clock } from '../../common/time/clock';
import { ChargeRepository } from '../../payments/charge.repository';
import { DisputeRepository } from '../../disputes/dispute.repository';
import { MerchantEntity } from '../merchant.entity';
import { MerchantRepository } from '../merchant.repository';
import { MerchantsService } from '../merchants.service';

import { DisputeRateCalculator, type DisputeRateResult } from './dispute-rate.calculator';

export interface RiskEvaluation {
  merchantId: MerchantId;
  rate: DisputeRateResult;
  action: 'restricted' | 'reinstated' | 'none';
}

/** One page of merchants per pass. The job loops until a page comes back short. */
const PAGE_SIZE = 200;

@Injectable()
export class RiskEvaluationService {
  constructor(
    private readonly merchants: MerchantRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /** One merchant. `RiskEvaluationJob` maps this over the live, active population. */
  async evaluate(merchant: MerchantEntity): Promise<RiskEvaluation> {
    const since = this.calculator.windowStart(this.clock.now());

    const [capturedCharges, disputesOpened] = await Promise.all([
      this.charges.countCapturedSince(merchant.id, since),
      this.disputes.countOpenedSince(merchant.id, since),
    ]);

  }
}
