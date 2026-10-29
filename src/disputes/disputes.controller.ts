/**
 * `/v1/disputes` — api-surface.md §6.
 *
 * Four routes and no POST that creates one: disputes arrive from the network, never from a
 * merchant. `accept` is `@StaffOnly('risk')` because conceding a chargeback writes off money
 * and the merchant's own admin should not be able to do it from a mis-click in the console;
 * risk ops does it on their behalf, with an audit row.
 */

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { AuthPrincipal, Dispute, DisputeId, DisputeStatus, Paginated } from '@payzeno/contracts';

import { ApiKeyGuard } from '../auth/guards/api-key.guard';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { BaseController } from '../common/base/base.controller';
import { ApiVersion } from '../common/decorators/api-version.decorator';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { StaffOnly } from '../common/decorators/staff-only.decorator';
import { currentCorrelationId } from '../common/logging/request-context';
import { StatusListQueryDto } from '../common/pagination/filtered-list-query.dto';
import { DisputesService } from './disputes.service';
import { SubmitDisputeEvidenceDto } from './dto/submit-dispute-evidence.dto';

@Controller('v1/disputes')
@MerchantScoped()
@UseGuards(ApiKeyGuard, SessionGuard, StaffGuard, MerchantScopeGuard)
export class DisputesController extends BaseController {
  constructor(private readonly disputes: DisputesService) {
    super();
  }

  @Get()
  @RequiredScopes('disputes:read')
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: StatusListQueryDto,
    @Query('status') status?: DisputeStatus,
  ): Promise<Paginated<Dispute>> {
    return this.disputes.list(principal, { ...query, limit: query.effectiveLimit(), status });
  }

  @Get(':disputeId')
  @ApiVersion('2026-01-15')
  @RequiredScopes('disputes:read')
  get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('disputeId') disputeId: DisputeId,
  ): Promise<Dispute> {
    return this.disputes.get(principal, disputeId);
  }

  /**
   * Session-only: evidence is a console workflow with file uploads behind it, and an API key
   * has no way to reference an uploaded file id.
   */
  @Post(':disputeId/evidence')
  @Idempotent()
  @AuditLog('dispute.evidence_submit', { resourceType: 'dispute', idParam: 'disputeId' })
  submitEvidence(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('disputeId') disputeId: DisputeId,
    @Body() dto: SubmitDisputeEvidenceDto,
  ): Promise<Dispute> {
    return this.disputes.submitEvidence(principal, disputeId, dto, currentCorrelationId());
  }

  @Post(':disputeId/accept')
  @StaffOnly('risk')
  @Idempotent()
  @AuditLog('dispute.accept', { resourceType: 'dispute', idParam: 'disputeId', captureBefore: true })
  accept(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('disputeId') disputeId: DisputeId,
  ): Promise<Dispute> {
    return this.disputes.accept(principal, disputeId, currentCorrelationId());
  }
}
