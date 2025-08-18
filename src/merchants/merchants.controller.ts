/**
 * `/v1/merchants` — api-surface.md §4.
 *
 * The auth markers are the interesting part and they are not decoration:
 *
 *   POST   /v1/merchants                  staff        a merchant cannot create itself
 *   GET    /v1/merchants/:id              apikey|session
 *   PATCH  /v1/merchants/:id              admin|staff  eight fields are staff-only
 *   POST   /v1/merchants/:id/status       staff(risk)  or a merchant un-suspends itself
 *
 * Chain E (blueprint §2.1) starts here:
 *   create → MerchantsService.create → MerchantOnboardingService.onboard
 *          → TransactionManager.runInTransaction → MerchantRepository.insert
 *          + OutboxEventPublisher.publish → LedgerHttpClient.bootstrapAccounts
 *          → BaseHttpClient.request
 */
import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import type { AuthPrincipal, Merchant, MerchantId, MerchantStatus, Paginated } from '@payzeno/contracts';

import { BaseController } from '../common/base/base.controller';
import { ApiVersion } from '../common/decorators/api-version.decorator';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { StaffOnly } from '../common/decorators/staff-only.decorator';
import { PermissionDeniedException } from '../common/errors/auth.exceptions';
import { ListQueryDto } from '../common/pagination/list-query.dto';
import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { describePrincipal, livemodeOf } from '../auth/principal/principal.factory';

import { CreateMerchantDto } from './dto/create-merchant.dto';
import { ChangeMerchantStatusDto, UpdateMerchantDto } from './dto/update-merchant.dto';
import { MerchantsService, STAFF_ONLY_MERCHANT_FIELDS } from './merchants.service';

@Controller('v1/merchants')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, StaffGuard, MerchantScopeGuard, RolesGuard)
export class MerchantsController extends BaseController {
  constructor(private readonly merchants: MerchantsService) {
    super();
  }

  @StaffOnly('risk')
  @Idempotent()
  /** Staff (risk). Emits `merchant.status_changed`; the ledger and the legacy biller consume it. */
  @Post(':merchantId/status')
}
