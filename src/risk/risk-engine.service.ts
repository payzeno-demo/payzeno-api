/**
 * RiskEngine — L4. Gathers the §8 signals for one authorised charge and asks the policy.
 *
 * Everything it reads is already on the charge (score, card country, fingerprint, shopper
 * address and country — written when the charge was inserted, so a 3-D Secure resume an hour
 * later is judged on the same shopper) plus three history queries. It decides; it changes
 * nothing. Acting on the decision — hold or void — is the confirm flow's job.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Merchant } from '@payzeno/contracts';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, daysBetween, type Clock } from '../common/time/clock';
import type { ChargeEntity } from '../payments/charge.entity';

import { evaluateRisk, type RiskDecision, type RiskSignals } from './risk-rules.policy';
import { RiskSignalsRepository } from './risk-signals.repository';

const HOUR_MS = 3_600_000;
const HISTORY_DAYS = 30;

export interface RiskAssessment extends RiskDecision {
  signals: RiskSignals;
}

@Injectable()
export class RiskEngine {
  constructor(
    private readonly history: RiskSignalsRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async assess(charge: ChargeEntity, merchant: Merchant): Promise<RiskAssessment> {
    const now = this.clock.now();
    const hourAgo = new Date(now.getTime() - HOUR_MS);
    const amountMinor = Number(charge.amount_minor);

    const [velocity, ipCards, merchantHistory] = await Promise.all([
      charge.card_fingerprint
        ? this.history.cardVelocity(charge.card_fingerprint, charge.livemode, hourAgo, charge.id)
        : Promise.resolve({ attempts: 0, failures: 0 }),
      charge.shopper_ip
        ? this.history.distinctCardsFromIp(charge.shopper_ip, charge.livemode, hourAgo)
        : Promise.resolve(null),
      this.history.merchantHistory(
        merchant.id,
        charge.currency,
        charge.livemode,
        new Date(now.getTime() - HISTORY_DAYS * 24 * HOUR_MS),
      ),
    ]);

    const signals: RiskSignals = {
      acquirerScore: charge.risk_score,
      amountMinor,
      currency: charge.currency,
      ipCountry: charge.shopper_country,
      cardCountry: charge.card_country,
      cardAttemptsLastHour: velocity.attempts,
      cardFailuresLastHour: velocity.failures,
      ipDistinctCardsLastHour: ipCards,
      merchantAverageMinor: merchantHistory.averageMinor,
      merchantSampleSize: merchantHistory.sampleSize,
      merchantAgeDays: daysBetween(new Date(merchant.created_at), now),
    };

    const decision = evaluateRisk(signals);
    if (decision.outcome !== 'allow') {
      // No fingerprint, no address: the rule names and the countries are enough to explain it.
      this.logger.info('risk_rules_fired', {
        charge_id: charge.id,
        merchant_id: merchant.id,
        outcome: decision.outcome,
        rules: decision.rules.join(','),
        ip_country: signals.ipCountry,
        card_country: signals.cardCountry,
      });
    }
    return { ...decision, signals };
  }
}
