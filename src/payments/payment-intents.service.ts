/**
 * PaymentIntentsService — the product's centre of gravity, and deliberately thin.
 *
 * Everything multi-aggregate delegates to a `PaymentFlow`. What is left here is what a
 * merchant-facing service should own: tenant scoping, the 404, the create write, and the
 * decision of which flow answers which route. When this file grows a `try { … acquirer … }`
 * block, the review comment is a link to `flows/payment.flow.ts`.
 *
 * Hot file: twelve months of churn, four authors. Keep it boring.
 */

import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type {
  AuthPrincipal,
  CancelPaymentIntentRequest,
  CapturePaymentIntentRequest,
  ConfirmPaymentIntentRequest,
  Paginated,
  PaymentIntent,
  PaymentIntentId,
  PaymentIntentListQuery,
  PaymentIntentStatus,
} from '@payzeno/contracts';

import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import { BaseService } from '../common/base/base.service';
import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { PaymentIntentNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { CancelPaymentFlow } from './flows/cancel-payment.flow';
import { CapturePaymentFlow } from './flows/capture-payment.flow';
import { ConfirmPaymentFlow } from './flows/confirm-payment.flow';
import { PaymentIntentEntity } from './payment-intent.entity';
import { PaymentIntentRepository } from './payment-intent.repository';

@Injectable()
export class PaymentIntentsService extends BaseService<PaymentIntentEntity> {
  constructor(
    private readonly intents: PaymentIntentRepository,
    private readonly confirmFlow: ConfirmPaymentFlow,
    private readonly captureFlow: CapturePaymentFlow,
    private readonly cancelFlow: CancelPaymentFlow,
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
    const now = this.clock.now();
    const id = this.ids.paymentIntentId() as PaymentIntentId;

    const row = await this.transactions.runInTransaction((manager) =>
      this.intents.insertIntent(manager, {
        id,
        merchantId: scope.merchantId,
        amount_minor: dto.amount_minor,
        currency: dto.currency,
        status,
        capture_method: dto.capture_method ?? 'automatic',
        payment_method_token: dto.payment_method_token ?? null,
        customer_reference: dto.customer_reference ?? null,
        description: dto.description ?? null,
        statement_descriptor: dto.statement_descriptor ?? null,
        latest_charge_id: null,
        client_secret: mintClientSecret(id),
        next_action: null,
        metadata: dto.metadata ?? {},
        canceled_at: null,
        cancellation_reason: null,
        livemode: scope.livemode,
        createdAt: now,
        updatedAt: now,
      }),
    );

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

  async get(principal: AuthPrincipal, id: PaymentIntentId): Promise<PaymentIntent> {
    return toPaymentIntent(await this.findOneOrThrow(id, scopeFrom(principal)));
  }

  async list(principal: AuthPrincipal, query: PaymentIntentListQuery): Promise<Paginated<PaymentIntent>> {
    const page = await this.paginate(query, scopeFrom(principal), (qb) => {
      let builder = qb;
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
  ): Promise<PaymentIntent> {
    const intent = await this.findOneOrThrow(id, scopeFrom(principal));
    return toPaymentIntent(await this.captureFlow.execute(intent, request));
  }

  async cancel(
    principal: AuthPrincipal,
    id: PaymentIntentId,
    request: CancelPaymentIntentRequest,
  ): Promise<PaymentIntent> {
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
  } as PaymentIntent;
}
