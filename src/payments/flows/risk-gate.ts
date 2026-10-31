/**
 * RiskGate — L6. What the confirm flow does with a `review` or `block` from the platform rules.
 * RFC platform-v2 §8. Not a `PaymentFlow`: it has no entry event of its own, it finishes the
 * confirm that is already in `processing`.
 *
 *   review  the approval lands in `requires_capture` with an open `Review` (`rv_`), written in
 *           the same commit as the intent; the merchant's owners and admins are emailed
 *           (`payment_review_opened`). Nothing is captured until a Payzeno risk analyst
 *           approves (ReviewsService).
 *   block   the authorisation the issuer approved is voided at the acquirer, the charge is
 *           recorded as a `fraud_suspected` failure, the intent goes back to
 *           `requires_payment_method` exactly like an issuer decline, and the ledger's hold is
 *           released. The caller gets a `CardDeclinedException` — to a shopper a block is a
 *           decline, and saying more would teach a fraudster which rule they tripped.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Merchant, ReviewId } from '@payzeno/contracts';
import { formatMoney } from '@payzeno/contracts/money';
import type { EntityManager } from 'typeorm';

import { CardDeclinedException } from '../../common/errors/card.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { TransactionManager } from '../../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../../common/time/clock';
import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { EVENT_PUBLISHER, type EventPublisher } from '../../events/publisher';
import { LedgerReadThroughService } from '../../ledger/ledger-read-through.service';
import { ledgerKey } from '../../ledger/ledger.types';
import { MerchantUserRepository } from '../../merchants/users/merchant-user.repository';
import { EmailService } from '../../notifications/email/email.service';
import { ReviewEntity } from '../../risk/review.entity';
import { ReviewRepository } from '../../risk/review.repository';
import type { RiskAssessment } from '../../risk/risk-engine.service';
import type { ChargeEntity } from '../charge.entity';
import { ChargeRepository } from '../charge.repository';
import type { PaymentIntentEntity } from '../payment-intent.entity';
import { PaymentIntentRepository } from '../payment-intent.repository';
import { ProcessorRouter } from '../processor/processor.router';
import { PaymentIntentStateMachine } from '../state/payment-intent.state-machine';

/** What the shopper and the merchant read on a blocked attempt. Deliberately unspecific. */
export const BLOCKED_MESSAGE = 'The payment was declined by Payzeno risk checks';

/** Merchant users told about a held payment. */
const REVIEW_NOTIFIED_ROLES = new Set(['owner', 'admin']);
const MAX_NOTIFIED_USERS = 50;

@Injectable()
export class RiskGate {
  constructor(
    private readonly intents: PaymentIntentRepository,
    private readonly states: PaymentIntentStateMachine,
    private readonly charges: ChargeRepository,
    private readonly router: ProcessorRouter,
    private readonly ledger: LedgerReadThroughService,
    private readonly reviews: ReviewRepository,
    private readonly users: MerchantUserRepository,
    private readonly email: EmailService,
    private readonly transactions: TransactionManager,
    @Inject(EVENT_PUBLISHER) private readonly events: EventPublisher,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * Writes the open review and queues the merchant emails. Called inside the transaction that
   * moves the intent to `requires_capture`, so a held intent always has its review.
   */
  async openReview(
    manager: EntityManager,
    intent: PaymentIntentEntity,
    charge: ChargeEntity,
    merchant: Merchant,
    risk: RiskAssessment,
    reviewId: ReviewId,
  ): Promise<ReviewEntity> {
    const now = this.clock.now();
    const row = new ReviewEntity();
    row.id = reviewId;
    row.merchantId = intent.merchantId;
    row.livemode = intent.livemode;
    row.paymentIntentId = intent.id;
    row.chargeId = charge.id;
    row.status = 'open';
    row.rules = risk.rules;
    row.riskScore = charge.risk_score;
    row.amountMinor = Number(charge.amount_minor);
    row.currency = charge.currency;
    row.ipCountry = charge.shopper_country;
    row.cardCountry = charge.card_country;
    row.openedAt = now;
    row.closedAt = null;
    row.closedBy = null;
    row.note = null;
    row.createdAt = now;
    row.updatedAt = now;
    await this.reviews.insertReview(manager, row);

    const amount = formatMoney({ amount_minor: row.amountMinor, currency: row.currency });
    const consoleUrl = `${this.config.publicUrls.console}/payments/${encodeURIComponent(intent.id)}`;
    const users = await this.users.listForMerchant(intent.merchantId, MAX_NOTIFIED_USERS);
    for (const user of users) {
      if (!REVIEW_NOTIFIED_ROLES.has(user.role) || !user.canLogIn()) continue;
      await this.email.queue(
        {
          template: 'payment_review_opened',
          to: user.email,
          data: { merchant_name: merchant.display_name, amount, payment_id: intent.id, console_url: consoleUrl },
          merchantId: intent.merchantId,
          livemode: intent.livemode,
        },
        manager,
      );
    }

    this.logger.info('payment_review_opened', {
      review_id: row.id,
      payment_intent_id: intent.id,
      charge_id: charge.id,
      rules: risk.rules.join(','),
    });
    return row;
  }

  /** The `block` landing. Always throws: the caller's confirm ends as a decline. */
  async block(intent: PaymentIntentEntity, charge: ChargeEntity, risk: RiskAssessment): Promise<never> {
    let voided = false;
    try {
      const adapter = this.router.forAcquirer(charge.acquirer, { livemode: charge.livemode });
      const result = await adapter.void({
        networkTransactionId: charge.network_transaction_id ?? '',
        idempotencyKey: ledgerKey('auth_release', charge.id),
      });
      voided = result.voided;
    } catch (err) {
      // The hold falls off at the acquirer by itself; ChargeExpiryJob releases it in the ledger.
      this.logger.error('risk_block_void_failed', err, { charge_id: charge.id, payment_intent_id: intent.id });
    }

    const declined = this.states.apply('processing', 'decline');
    const failedAt = this.clock.now();
    await this.transactions.runInTransaction(async (manager) => {
      await this.charges.markBlocked(manager, charge.id, voided, BLOCKED_MESSAGE);
      await this.intents.transitionStatus(manager, intent.id, 'processing', declined, {
        latest_charge_id: charge.id,
        next_action: null,
      });
      await this.events.publish(
        'payment.failed',
        {
          charge_id: charge.id,
          payment_intent_id: intent.id,
          merchant_id: intent.merchantId,
          amount_minor: Number(charge.amount_minor),
          currency: charge.currency,
          failure_code: 'fraud_suspected',
          failure_message: BLOCKED_MESSAGE,
          retryable: false,
          failed_at: failedAt.toISOString(),
          ...(intent.subscription_id ? { subscription_id: intent.subscription_id } : {}),
        },
        {
          merchantId: intent.merchantId,
          correlationId: intent.id,
          causationId: null,
          livemode: intent.livemode,
          occurredAt: failedAt.toISOString(),
        },
      );
    });
    intent.status = declined;
    intent.latest_charge_id = charge.id;
    intent.next_action = null;

    if (voided) {
      try {
        // Same deterministic key as a cancel's release: a retry, or the expiry job, is a no-op.
        await this.ledger.releaseAuthorization({
          chargeId: charge.id,
          merchantId: intent.merchantId,
          currency: charge.currency,
          livemode: charge.livemode,
          amountMinor: Number(charge.amount_minor),
        });
      } catch (err) {
        this.logger.error('risk_block_ledger_release_failed', err, { charge_id: charge.id });
      }
    }

    this.logger.warn('payment_blocked_by_risk', {
      payment_intent_id: intent.id,
      charge_id: charge.id,
      rules: risk.rules.join(','),
      voided,
    });
    throw new CardDeclinedException('fraud_suspected', BLOCKED_MESSAGE);
  }
}
