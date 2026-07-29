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
    const scope = scopeFrom(principal);
    const now = this.clock.now();
    const id = this.ids.paymentIntentId() as PaymentIntentId;

    const status: PaymentIntentStatus = dto.payment_method_token
      ? 'requires_confirmation'
      : 'requires_payment_method';

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
    return toPaymentIntent(await this.confirmFlow.execute(intent, request));
  }

  async capture(
    principal: AuthPrincipal,
    id: PaymentIntentId,
    request: CapturePaymentIntentRequest,
  ): Promise<PaymentIntent> {
    const intent = await this.findOneOrThrow(id, scopeFrom(principal));
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

export function toPaymentIntent(row: PaymentIntentEntity): PaymentIntent {
  return {
    id: row.id,
    object: 'payment_intent',
    merchant_id: row.merchantId,
    amount_minor: Number(row.amount_minor),
    currency: row.currency,
    status: row.status,
    capture_method: row.capture_method,
    payment_method_token: row.payment_method_token,
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
  } as PaymentIntent;
}
