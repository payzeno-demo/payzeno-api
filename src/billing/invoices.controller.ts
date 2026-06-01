/**
 * `/v1/invoices` — api-surface.md §9.
 *
 * Three routes, none of which own their data: everything behind them lives in
 * payzeno-billing-legacy. The `X-Payzeno-Invoice-Source` response header is a debug
 * affordance for arc MIG — support asks "was that the projection or the legacy service?"
 * often enough that guessing from latency stopped being funny.
 */

import { Controller, Get, Header, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthPrincipal, Invoice, InvoiceStatus, Paginated } from '@payzeno/contracts';

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
import { ListQueryDto } from '../common/pagination/list-query.dto';
import { InvoiceSourceResolver } from './invoice-source.resolver';
import { InvoicesService } from './invoices.service';

@Controller('v1/invoices')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, MerchantScopeGuard, RolesGuard)
export class InvoicesController extends BaseController {
  constructor(
    private readonly invoices: InvoicesService,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: ListQueryDto,
    @Res({ passthrough: true }) res: Response,
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('invoiceId') invoiceId: string,
  ): Promise<Invoice> {
    return this.invoices.get(principal, invoiceId);
  }

  /**
   * Voiding is irreversible in the legacy service — there is no un-void handler in
   * `InvoiceController.java` and finance has asked twice. Hence owner/admin only, idempotent,
   * and audited with the before-image.
   */
  @Post(':invoiceId/void')
  @Roles('owner', 'admin')
  @Idempotent()
  @AuditLog('invoice.void', { resourceType: 'invoice', idParam: 'invoiceId', captureBefore: true })
  voidInvoice(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('invoiceId') invoiceId: string,
  ): Promise<Invoice> {
    return this.invoices.voidInvoice(principal, invoiceId);
  }
}
