/**
 * ReviewsService — L7. Payments held by Payzeno's risk rules, and the analyst's decision.
 * RFC platform-v2 §8.
 *
 *   approve  capture the held authorisation (the shopper gets their `receipt` from the capture
 *            commit), close the review `approved`.
 *   decline  void it — the intent is cancelled `fraudulent`; the shopper was never charged — close
 *            the review `declined` and tell the shopper (`payment_declined_after_review`).
 *
 * The money moves first, then the review closes. A decision that crashes in between leaves an
 * open review over a captured (or cancelled) intent, and deciding again finishes the job
 * instead of failing on the terminal intent.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  REVIEW_STATUSES,
  type AuthPrincipal,
  type MerchantId,
  type Paginated,
  type Review,
  type ReviewListQuery,
  type ReviewStatus,
} from '@payzeno/contracts';
import { formatMoney } from '@payzeno/contracts/money';

import { livemodeOf, merchantIdOf, staffIdOf } from '../auth/principal/principal.factory';
import { scopeOf, type MerchantScope } from '../common/base/merchant-scoped.entity';
import { ConflictException, ValidationException } from '../common/errors/api.exception';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { resolveListQuery } from '../common/pagination/list-query.dto';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { MerchantsService } from '../merchants/merchants.service';
import { EmailService } from '../notifications/email/email.service';
import { CancelPaymentFlow } from '../payments/flows/cancel-payment.flow';
import { CapturePaymentFlow } from '../payments/flows/capture-payment.flow';
import type { PaymentIntentEntity } from '../payments/payment-intent.entity';
import { PaymentIntentsService } from '../payments/payment-intents.service';

import { toReview, type ReviewEntity } from './review.entity';
import { ReviewRepository } from './review.repository';

export interface ReviewDecision {
  note?: string;
}

@Injectable()
export class ReviewsService {
  constructor(
    private readonly reviews: ReviewRepository,
    private readonly paymentIntents: PaymentIntentsService,
    private readonly captureFlow: CapturePaymentFlow,
    private readonly cancelFlow: CancelPaymentFlow,
    private readonly merchants: MerchantsService,
    private readonly email: EmailService,
    private readonly transactions: TransactionManager,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  // -- merchant (read only) ---------------------------------------------------------

  async list(principal: AuthPrincipal, query: ReviewListQuery): Promise<Paginated<Review>> {
    const page = await this.reviews.listScoped(scopeFrom(principal), resolveListQuery(query), assertStatus(query.status));
    return { ...page, data: page.data.map(toReview) };
  }

  async get(principal: AuthPrincipal, id: string): Promise<Review> {
    const row = await this.reviews.findScoped(id, scopeFrom(principal));
    if (!row) throw new ResourceNotFoundException('review', id);
    return toReview(row);
  }

  // -- staff ------------------------------------------------------------------------

  async listAll(query: ReviewListQuery & { merchant_id?: MerchantId }): Promise<Paginated<Review>> {
    const page = await this.reviews.listAll(resolveListQuery(query), {
      status: assertStatus(query.status),
      merchantId: query.merchant_id,
    });
    return { ...page, data: page.data.map(toReview) };
  }

  async approve(principal: AuthPrincipal, id: string, decision: ReviewDecision): Promise<Review> {
    const review = await this.requireOpen(id);
    const intent = await this.paymentIntents.requireInScope(scopeOf(review), review.paymentIntentId);

    if (intent.status === 'requires_capture') {
      await this.captureFlow.execute(intent, {});
    } else if (intent.status !== 'succeeded') {
      throw new ConflictException(`The held payment is '${intent.status}' and can no longer be captured`, {
        review_id: review.id,
        payment_intent_id: intent.id,
        status: intent.status,
      });
    }

    const closed = await this.close(review, 'approved', principal, decision);
    this.logger.info('payment_review_approved', { review_id: review.id, payment_intent_id: intent.id });
    return closed;
  }

  async decline(principal: AuthPrincipal, id: string, decision: ReviewDecision): Promise<Review> {
    const review = await this.requireOpen(id);
    const intent = await this.paymentIntents.requireInScope(scopeOf(review), review.paymentIntentId);

    if (intent.status === 'succeeded') {
      throw new ConflictException('The held payment was already captured; refund it instead', {
        review_id: review.id,
        payment_intent_id: intent.id,
      });
    }
    if (!intent.isTerminal()) {
      await this.cancelFlow.execute(intent, { cancellation_reason: 'fraudulent' });
    }

    const closed = await this.close(review, 'declined', principal, decision, intent);
    this.logger.info('payment_review_declined', { review_id: review.id, payment_intent_id: intent.id });
    return closed;
  }

  private async requireOpen(id: string): Promise<ReviewEntity> {
    const review = await this.reviews.findById(id);
    if (!review) throw new ResourceNotFoundException('review', id);
    if (review.status !== 'open') {
      throw new ConflictException(`This review was already ${review.status}`, { review_id: id, status: review.status });
    }
    return review;
  }

  /** Closes the review; a declined one also queues the shopper's email in the same commit. */
  private async close(
    review: ReviewEntity,
    status: 'approved' | 'declined',
    principal: AuthPrincipal,
    decision: ReviewDecision,
    declinedIntent?: PaymentIntentEntity,
  ): Promise<Review> {
    const closedAt = this.clock.now();
    const closedBy = staffIdOf(principal);
    const note = decision.note ?? null;
    const merchant = declinedIntent?.receipt_email ? await this.merchants.getById(review.merchantId) : null;

    await this.transactions.runInTransaction(async (manager) => {
      const affected = await this.reviews.close(manager, review.id, { status, closedAt, closedBy, note });
      if (affected === 0) {
        throw new ConflictException('Another analyst decided this review first', { review_id: review.id });
      }
      if (declinedIntent?.receipt_email && merchant) {
        await this.email.queue(
          {
            template: 'payment_declined_after_review',
            to: declinedIntent.receipt_email,
            data: {
              merchant_name: merchant.displayName,
              amount: formatMoney({ amount_minor: Number(review.amountMinor), currency: review.currency }),
            },
            merchantId: review.merchantId,
            livemode: review.livemode,
          },
          manager,
        );
      }
    });

    review.status = status;
    review.closedAt = closedAt;
    review.closedBy = closedBy;
    review.note = note;
    return toReview(review);
  }
}

function scopeFrom(principal: AuthPrincipal): MerchantScope {
  return { merchantId: merchantIdOf(principal), livemode: livemodeOf(principal) };
}

/** `?status=` arrives unvalidated; an unknown value would otherwise reach the query. */
function assertStatus(status: string | undefined): ReviewStatus | undefined {
  if (status === undefined || status === '') return undefined;
  if (!isReviewStatus(status)) {
    throw new ValidationException('Unknown review status', [
      { path: 'status', code: 'invalid_value', message: REVIEW_STATUSES.join(', ') },
    ]);
  }
  return status;
}

function isReviewStatus(value: string): value is ReviewStatus {
  return (REVIEW_STATUSES as readonly string[]).includes(value);
}
