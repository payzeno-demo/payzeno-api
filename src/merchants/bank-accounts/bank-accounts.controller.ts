/**
 * `/v1/bank-accounts` — api-surface.md §4. Session-only, admin for the writes.
 *
 * `CreateBankAccountDto` carries a `bat_` vault token, never an account number
 * (domain-model.md §11.3), and it is `@Redact(...)`-decorated so the fields that only exist on
 * this request never reach a log line.
 */
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import type { AuthPrincipal, BankAccount, ListQuery, Paginated } from '@payzeno/contracts';

import { BaseController } from '../../common/base/base.controller';
import { AuditLog } from '../../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../../common/decorators/current-principal.decorator';
import { Idempotent } from '../../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../../common/decorators/merchant-scoped.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ListQueryDto } from '../../common/pagination/list-query.dto';
import { MerchantScopeGuard } from '../../auth/guards/merchant-scope.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { SessionGuard } from '../../auth/guards/session.guard';

import { CreateBankAccountDto } from '../dto/create-bank-account.dto';

import { BankAccountsService } from './bank-accounts.service';

@Controller('v1/bank-accounts')
@MerchantScoped()
@UseGuards(SessionGuard, MerchantScopeGuard, RolesGuard)
export class BankAccountsController extends BaseController {
  constructor(private readonly accounts: BankAccountsService) {
    super();
  }

  @Roles('owner', 'admin')
  @AuditLog('bank_account.create', { resourceType: 'bank_account' })
  async create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: CreateBankAccountDto,
  ): Promise<BankAccount> {
    return this.accounts.create(this.scopeOf(principal), body);
  }

  @Post(':bankAccountId/default')
}
