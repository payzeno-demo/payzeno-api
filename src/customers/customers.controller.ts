/**
 * `/v1/customers` — RFC platform-v2 §5. A merchant's customers and their saved cards.
 *
 * Api keys (`customers:read` / `customers:write`) and console sessions. Saved cards are listed
 * and removed here but never created here: a card is saved by a checkout payment the shopper
 * agreed to, or by a `setup` session — never by a merchant holding a token.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthPrincipal, Customer, Paginated, PaymentMethod } from '@payzeno/contracts';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { BaseController } from '../common/base/base.controller';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { Roles } from '../common/decorators/roles.decorator';

import { CustomersService } from './customers.service';
import { CreateCustomerDto, CustomerListQueryDto, UpdateCustomerDto } from './dto/customer.dto';

@Controller('v1/customers')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard, RolesGuard)
export class CustomersController extends BaseController {
  constructor(private readonly customers: CustomersService) {
    super();
  }

  @Post()
  @HttpCode(201)
  @Roles('developer')
  @Idempotent()
  @RequiredScopes('customers:write')
  @AuditLog('customer.create', { resourceType: 'customer' })
  create(@CurrentPrincipal() principal: AuthPrincipal, @Body() dto: CreateCustomerDto): Promise<Customer> {
    return this.customers.create(principal, dto);
  }

  @Get()
  @RequiredScopes('customers:read')
  list(@CurrentPrincipal() principal: AuthPrincipal, @Query() query: CustomerListQueryDto): Promise<Paginated<Customer>> {
    return this.customers.list(principal, { cursor: query.cursor, limit: query.effectiveLimit(), email: query.email });
  }

  @Get(':customerId')
  @RequiredScopes('customers:read')
  get(@CurrentPrincipal() principal: AuthPrincipal, @Param('customerId') customerId: string): Promise<Customer> {
    return this.customers.get(principal, customerId);
  }

  @Patch(':customerId')
  @Roles('developer')
  @RequiredScopes('customers:write')
  @AuditLog('customer.update', { resourceType: 'customer', idParam: 'customerId' })
  update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('customerId') customerId: string,
    @Body() dto: UpdateCustomerDto,
  ): Promise<Customer> {
    return this.customers.update(principal, customerId, dto);
  }

  @Get(':customerId/payment_methods')
  @RequiredScopes('customers:read')
  listPaymentMethods(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('customerId') customerId: string,
  ): Promise<Paginated<PaymentMethod>> {
    return this.customers.listPaymentMethods(principal, customerId);
  }

  @Delete(':customerId/payment_methods/:paymentMethodId')
  @Roles('developer')
  @RequiredScopes('customers:write')
  @AuditLog('payment_method.detach', { resourceType: 'payment_method', idParam: 'paymentMethodId' })
  detachPaymentMethod(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('customerId') customerId: string,
    @Param('paymentMethodId') paymentMethodId: string,
  ): Promise<PaymentMethod> {
    return this.customers.detachPaymentMethod(principal, customerId, paymentMethodId);
  }
}
