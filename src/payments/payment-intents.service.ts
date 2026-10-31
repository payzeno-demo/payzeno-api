/**
 * PaymentIntentsService — the product's centre of gravity, and deliberately thin.
 *
 * Everything multi-aggregate delegates to a `PaymentFlow`. What is left here is what a
 * merchant-facing service should own: tenant scoping, the 404, the create write, and the
 * decision of which flow answers which route. When this file grows a `try { … acquirer … }`
 * block, the review comment is a link to `flows/payment.flow.ts`.
 *
 * RFC platform-v2 added three things and no flow logic: the live gate on create (§3 — a live
 * intent needs an `active` merchant), `createInternal` for the callers that set the §5–§7
 * fields the public request cannot (checkout, subscriptions), and the refusal to let a merchant
 * capture a payment Payzeno risk is still reviewing (§8).
 *
 * Hot file: twelve months of churn, four authors. Keep it boring.
 */

import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthPrincipal,
  CancelPaymentIntentRequest,
  CapturePaymentIntentRequest,
  CaptureMethod,
  ConfirmPaymentIntentRequest,
  CurrencyCode,
  CustomerId,
  Metadata,
  Paginated,
  PaymentIntent,
  PaymentIntentId,
  PaymentIntentListQuery,
  PaymentIntentStatus,
  PaymentMethodId,
  SubscriptionId,
} from '@payzeno/contracts';
import type { EntityManager } from 'typeorm';

import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import { BaseService } from '../common/base/base.service';
import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { ConflictException } from '../common/errors/api.exception';
import { MerchantNotActivatedException } from '../common/errors/business.exceptions';
import { PaymentIntentNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { MerchantsService } from '../merchants/merchants.service';
import { ReviewRepository } from '../risk/review.repository';

import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { CancelPaymentFlow } from './flows/cancel-payment.flow';
import { CapturePaymentFlow } from './flows/capture-payment.flow';
import { ConfirmPaymentFlow, type ConfirmContext } from './flows/confirm-payment.flow';
import { PaymentIntentEntity } from './payment-intent.entity';
import { PaymentIntentRepository } from './payment-intent.repository';

/**
 * Statuses that may take payments live. `restricted` still charges — it only may not be paid
 * out (domain-model §1); `suspended` and worse never get here, MerchantScopeGuard refuses
 * every write first.
 */
const LIVE_CHARGEABLE_STATUSES = new Set(['active', 'restricted']);

/** What the internal callers can set on a new intent that `CreatePaymentIntentRequest` cannot. */
export interface InternalIntentInput {
  amount_minor: number;
  currency: CurrencyCode;
  capture_method?: CaptureMethod;
  payment_method_token?: string | null;
  description?: string | null;
  customer_reference?: string | null;
  metadata?: Metadata;
  customer_id?: CustomerId | null;
  payment_method_id?: PaymentMethodId | null;
  receipt_email?: string | null;
  subscription_id?: SubscriptionId | null;
}

@Injectable()
export class PaymentIntentsService extends BaseService<PaymentIntentEntity> {
  constructor(
    private readonly intents: PaymentIntentRepository,
    private readonly confirmFlow: ConfirmPaymentFlow,
    private readonly captureFlow: CapturePaymentFlow,
    private readonly cancelFlow: CancelPaymentFlow,
    private readonly merchants: MerchantsService,
    private readonly reviews: ReviewRepository,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(intents, logger);
  }

  get entityName(): string {
    return 'payment_intent';
  }

  protected override notFound(id: string): PaymentIntentNotFoundException {
    return new PaymentIntentNotFoundException(id);
  }

  /**
   * `livemode` comes from the principal, never from the body. A `sk_test_` key that could ask
   * for a live intent would put test payments in the live chart of accounts and make them
   * payable to a real bank account (domain-model §11.5).
   */
  async create(principal: AuthPrincipal, dto: CreatePaymentIntentDto): Promise<PaymentIntent> {
    const scope = scopeFrom(principal);
    const row = await this.createInternal(scope, {
      amount_minor: dto.amount_minor,
      currency: dto.currency,
      capture_method: dto.capture_method,
      payment_method_token: dto.payment_method_token ?? null,
      customer_reference: dto.customer_reference ?? null,
      description: dto.description ?? null,
      metadata: dto.metadata,
    }, undefined, dto.statement_descriptor ?? null);

    this.logger.info('payment_intent_created', {
      payment_intent_id: row.id,
      merchant_id: scope.merchantId,
      amount_minor: dto.amount_minor,
      currency: dto.currency,
      status: row.status,
      confirm_in_same_call: Boolean(dto.confirm),
    });

    if (dto.confirm && dto.payment_method_token) {
      const confirmed = await this.confirmFlow.execute(row, {
        payment_method_token: dto.payment_method_token,
      });
      return toPaymentIntent(confirmed);
    }

    return toPaymentIntent(row);
  }

  /**
   * The one INSERT path, for the public create and for checkout and subscriptions. Refuses a
   * live intent for a merchant that is not activated yet (RFC platform-v2 §3); test mode is
   * never refused. `manager` joins the caller's transaction.
   */
  async createInternal(
    scope: MerchantScope,
    input: InternalIntentInput,
    manager?: EntityManager,
    statementDescriptor: string | null = null,
  ): Promise<PaymentIntentEntity> {
    await this.assertMayChargeLive(scope);

    const now = this.clock.now();
    const id = this.ids.paymentIntentId() as PaymentIntentId;
    const status: PaymentIntentStatus = input.payment_method_token
      ? 'requires_confirmation'
      : 'requires_payment_method';

    return this.transactions.runInTransaction(
      (tx) =>
        this.intents.insertIntent(tx, {
          id,
          merchantId: scope.merchantId,
          amount_minor: input.amount_minor,
          currency: input.currency,
          status,
          capture_method: input.capture_method ?? 'automatic',
          payment_method_token: input.payment_method_token ?? null,
          customer_reference: input.customer_reference ?? null,
          description: input.description ?? null,
          statement_descriptor: statementDescriptor,
          latest_charge_id: null,
          client_secret: mintClientSecret(id),
          next_action: null,
          metadata: input.metadata ?? {},
          canceled_at: null,
          cancellation_reason: null,
          customer_id: input.customer_id ?? null,
          payment_method_id: input.payment_method_id ?? null,
          receipt_email: input.receipt_email ?? null,
          presentment: null,
          review_id: null,
          subscription_id: input.subscription_id ?? null,
          livemode: scope.livemode,
          createdAt: now,
          updatedAt: now,
        }),
      manager,
    );
  }

  /** RFC platform-v2 §3. Public so checkout can refuse before it writes a customer. */
  async assertMayChargeLive(scope: MerchantScope): Promise<void> {
    if (!scope.livemode) return;
    const merchant = await this.merchants.getById(scope.merchantId);
    if (!LIVE_CHARGEABLE_STATUSES.has(merchant.status)) {
      throw new MerchantNotActivatedException(merchant.id, merchant.status);
    }
  }

  async get(principal: AuthPrincipal, id: PaymentIntentId): Promise<PaymentIntent> {
    return toPaymentIntent(await this.findOneOrThrow(id, scopeFrom(principal)));
  }

  /** Internal read by scope, for checkout and subscriptions. */
  requireInScope(scope: MerchantScope, id: PaymentIntentId): Promise<PaymentIntentEntity> {
    return this.findOneOrThrow(id, scope);
  }

  async list(principal: AuthPrincipal, query: PaymentIntentListQuery): Promise<Paginated<PaymentIntent>> {
    const page = await this.paginate(query, scopeFrom(principal), (qb) => {
      // A `setup` checkout session's zero-amount intent only ever carried the vault bearer;
      // it is not a payment and does not belong in the payments list.
      let builder = qb.andWhere('payment_intent.amount_minor > 0');
      if (query.status) {
        builder = builder.andWhere('payment_intent.status = :status', { status: query.status });
      }
      if (query.customer_reference) {
        builder = builder.andWhere('payment_intent.customer_reference = :ref', {
          ref: query.customer_reference,
        });
      }
      return builder;
    });

    return { ...page, data: page.data.map(toPaymentIntent) };
  }

  async confirm(
    principal: AuthPrincipal,
    id: PaymentIntentId,
    request: ConfirmPaymentIntentRequest,
    context?: ConfirmContext,
  ): Promise<PaymentIntent> {
    const intent = await this.findOneOrThrow(id, scopeFrom(principal));
    return toPaymentIntent(await this.confirmFlow.execute(intent, request, context));
  }

  /** Checkout and the renewal job: confirm an intent they already hold the scope of. */
  async confirmInScope(
    scope: MerchantScope,
    id: PaymentIntentId,
    request: ConfirmPaymentIntentRequest,
    context?: ConfirmContext,
  ): Promise<PaymentIntentEntity> {
    const intent = await this.findOneOrThrow(id, scope);
    return this.confirmFlow.execute(intent, request, context);
  }

  async capture(
    principal: AuthPrincipal,
    id: PaymentIntentId,
    request: CapturePaymentIntentRequest,
  ): Promise<PaymentIntent> {
    const intent = await this.findOneOrThrow(id, scopeFrom(principal));
    await this.assertNotUnderReview(intent);
    return toPaymentIntent(await this.captureFlow.execute(intent, request));
  }

  async cancel(
    principal: AuthPrincipal,
    id: PaymentIntentId,
    request: CancelPaymentIntentRequest,
  ): Promise<PaymentIntent> {
    const intent = await this.findOneOrThrow(id, scopeFrom(principal));
    return toPaymentIntent(await this.cancelFlow.execute(intent, request));
  }

  /** Internal cancel by scope: checkout expiry, an off-session renewal stuck on 3-D Secure. */
  async cancelInScope(scope: MerchantScope, id: PaymentIntentId, request: CancelPaymentIntentRequest): Promise<PaymentIntentEntity> {
    const intent = await this.findOneOrThrow(id, scope);
    return this.cancelFlow.execute(intent, request);
  }

  /**
   * `ClientSecretGuard`'s lookup. The secret is the credential and carries its own scope, so
   * there is no merchant id to check against here — the guard builds the principal from the
   * row this returns.
   */
  async getByClientSecret(clientSecret: string): Promise<PaymentIntentEntity> {
    const row = await this.intents.findByClientSecret(clientSecret);
    if (!row) {
      throw new PaymentIntentNotFoundException(null);
    }
    return row;
  }

  /** Terminal intents accept a metadata patch and nothing else (domain-model §2). */
  async patchMetadata(
    principal: AuthPrincipal,
    id: PaymentIntentId,
    metadata: Record<string, string>,
  ): Promise<PaymentIntent> {
    const scope = scopeFrom(principal);
    const intent = await this.findOneOrThrow(id, scope);
    await this.intents.updateScoped(id, scope, { metadata } as never);
    intent.metadata = metadata;
    return toPaymentIntent(intent);
  }

  /** RFC platform-v2 §8: a held payment is Payzeno risk's to capture or void, not the merchant's. */
  private async assertNotUnderReview(intent: PaymentIntentEntity): Promise<void> {
    if (!intent.review_id) return;
    const review = await this.reviews.findOne({ where: { id: intent.review_id } });
    if (review?.status === 'open') {
      throw new ConflictException('This payment is being reviewed by Payzeno and cannot be captured yet', {
        payment_intent_id: intent.id,
        review_id: review.id,
        reason: 'under_review',
      });
    }
  }
}

function scopeFrom(principal: AuthPrincipal): MerchantScope {
  return { merchantId: merchantIdOf(principal), livemode: livemodeOf(principal) };
}

/**
 * `pi_<ulid>_secret_<32 hex>`. Browser-visible, so it is minted from a CSPRNG and never
 * derived from the id — a derivable client secret is a merchant-wide read for anyone who can
 * guess an id.
 */
function mintClientSecret(id: PaymentIntentId): string {
  return `${id}_secret_${randomBytes(16).toString('hex')}`;
}

/**
 * The wire shape. `payment_method_token` is deliberately absent: it is not in the contract, and
 * for a saved card it is the reusable vault token — a bearer for that card, forever.
 */
export function toPaymentIntent(row: PaymentIntentEntity): PaymentIntent {
  return {
    id: row.id,
    object: 'payment_intent',
    merchant_id: row.merchantId,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    capture_method: row.capture_method,
    customer_reference: row.customer_reference,
    description: row.description,
    statement_descriptor: row.statement_descriptor,
    latest_charge_id: row.latest_charge_id,
    client_secret: row.client_secret,
    next_action: row.next_action,
    livemode: row.livemode,
    metadata: row.metadata,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
    canceled_at: row.canceled_at ? row.canceled_at.toISOString() : null,
    cancellation_reason: row.cancellation_reason,
    customer_id: row.customer_id ?? null,
    payment_method_id: row.payment_method_id ?? null,
    receipt_email: row.receipt_email ?? null,
    presentment: row.presentment ?? null,
    review_id: row.review_id ?? null,
    subscription_id: row.subscription_id ?? null,
  };
}
