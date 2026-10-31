/**
 * CustomersService — L7. A merchant's customers and their saved cards. RFC platform-v2 §5.
 *
 * The merchant-facing half (`/v1/customers`) and the two internal entry points checkout and
 * subscriptions use: `createInternal` (checkout's `customer_creation`) and `requireInScope`.
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  AuthPrincipal,
  Customer,
  CustomerId,
  CustomerListQuery,
  Metadata,
  Paginated,
  PaymentMethod,
  PaymentMethodId,
} from '@payzeno/contracts';
import type { EntityManager } from 'typeorm';

import { livemodeOf, merchantIdOf } from '../auth/principal/principal.factory';
import { BaseService } from '../common/base/base.service';
import type { MerchantScope } from '../common/base/merchant-scoped.entity';
import { ResourceNotFoundException } from '../common/errors/not-found.exceptions';
import { IdFactory } from '../common/ids/id.factory';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { resolveListQuery } from '../common/pagination/list-query.dto';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { CLOCK, type Clock } from '../common/time/clock';
import { toPaymentMethod } from '../payment-methods/payment-method.entity';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service';

import { CUSTOMER_ID_PREFIX, CustomerEntity, toCustomer } from './customer.entity';
import { CustomerRepository, type CustomerPatch } from './customer.repository';
import type { CreateCustomerDto, UpdateCustomerDto } from './dto/customer.dto';

export interface NewCustomer {
  email: string | null;
  name: string | null;
  metadata?: Metadata;
}

@Injectable()
export class CustomersService extends BaseService<CustomerEntity> {
  constructor(
    private readonly customers: CustomerRepository,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly transactions: TransactionManager,
    private readonly ids: IdFactory,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) logger: PayzenoLogger,
  ) {
    super(customers, logger);
  }

  get entityName(): string {
    return 'customer';
  }

  async create(principal: AuthPrincipal, dto: CreateCustomerDto): Promise<Customer> {
    const row = await this.createInternal(scopeFrom(principal), {
      email: dto.email ?? null,
      name: dto.name ?? null,
      metadata: dto.metadata,
    });
    return toCustomer(row);
  }

  /** Checkout's `customer_creation` and the API create share this. `manager` joins the caller's commit. */
  async createInternal(scope: MerchantScope, input: NewCustomer, manager?: EntityManager): Promise<CustomerEntity> {
    const now = this.clock.now();
    const row = new CustomerEntity();
    row.id = this.ids.opaque(CUSTOMER_ID_PREFIX);
    row.merchantId = scope.merchantId;
    row.livemode = scope.livemode;
    row.email = input.email;
    row.name = input.name;
    row.defaultPaymentMethodId = null;
    row.metadata = input.metadata ?? {};
    row.createdAt = now;
    row.updatedAt = now;

    await this.customers.insertCustomer(row, manager);
    this.logger.info('customer_created', { customer_id: row.id, merchant_id: scope.merchantId, livemode: scope.livemode });
    return row;
  }

  async get(principal: AuthPrincipal, id: CustomerId): Promise<Customer> {
    return toCustomer(await this.findOneOrThrow(id, scopeFrom(principal)));
  }

  /** The 404 every internal caller wants: a customer id of another tenant or mode is not found. */
  requireInScope(scope: MerchantScope, id: CustomerId): Promise<CustomerEntity> {
    return this.findOneOrThrow(id, scope);
  }

  async list(principal: AuthPrincipal, query: CustomerListQuery): Promise<Paginated<Customer>> {
    const page = await this.customers.listScoped(scopeFrom(principal), resolveListQuery(query), query.email);
    return { ...page, data: page.data.map(toCustomer) };
  }

  async update(principal: AuthPrincipal, id: CustomerId, dto: UpdateCustomerDto): Promise<Customer> {
    const scope = scopeFrom(principal);
    const row = await this.findOneOrThrow(id, scope);

    const patch: CustomerPatch = {};
    if (dto.email !== undefined) patch.email = dto.email;
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.metadata !== undefined) patch.metadata = dto.metadata;
    if (dto.default_payment_method_id !== undefined) {
      // Must be one of this customer's attached cards; anything else is the same 404.
      await this.paymentMethods.getUsable(scope, row.id, dto.default_payment_method_id);
      patch.defaultPaymentMethodId = dto.default_payment_method_id;
    }

    if (Object.keys(patch).length > 0) {
      await this.customers.patch(scope, row.id, patch);
      Object.assign(row, patch);
    }
    return toCustomer(row);
  }

  async listPaymentMethods(principal: AuthPrincipal, id: CustomerId): Promise<Paginated<PaymentMethod>> {
    const scope = scopeFrom(principal);
    const customer = await this.findOneOrThrow(id, scope);
    const rows = await this.paymentMethods.list(scope, customer.id);
    return { data: rows.map(toPaymentMethod), has_more: false, next_cursor: null };
  }

  /**
   * `DELETE /v1/customers/:id/payment_methods/:pm`. The card stops being the customer's default
   * in the same commit. A subscription still pointing at it fails its next renewal and goes
   * through the update-your-card email, which is exactly what a removed card should cause.
   */
  async detachPaymentMethod(principal: AuthPrincipal, id: CustomerId, paymentMethodId: PaymentMethodId): Promise<PaymentMethod> {
    const scope = scopeFrom(principal);
    const customer = await this.findOneOrThrow(id, scope);

    const detached = await this.transactions.runInTransaction(async (manager) => {
      const row = await this.paymentMethods.detach(manager, scope, customer.id, paymentMethodId);
      await this.customers.clearDefaultPaymentMethod(manager, row.id);
      return row;
    });
    await this.paymentMethods.forgetToken(detached);

    this.logger.info('payment_method_detached', { payment_method_id: detached.id, customer_id: customer.id });
    return toPaymentMethod(detached);
  }

  protected override notFound(id: string): ResourceNotFoundException {
    return new ResourceNotFoundException('customer', id);
  }
}

function scopeFrom(principal: AuthPrincipal): MerchantScope {
  return { merchantId: merchantIdOf(principal), livemode: livemodeOf(principal) };
}
