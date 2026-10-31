/**
 * `/v1/admin/merchants` — the back office's merchant screens (RFC platform-v2 §1).
 *
 *   GET  /                                     any staff   Paginated<AdminMerchantSummary>
 *   GET  /:merchantId                          any staff   AdminMerchantDetail
 *   GET  /:merchantId/documents/:doc/content   any staff   the document's bytes, audited
 *   POST /:merchantId/onboarding/approve       risk        AdminMerchantDetail
 *   POST /:merchantId/onboarding/reject        risk        AdminMerchantDetail (message required)
 *   POST /:merchantId/onboarding/request-info  risk        AdminMerchantDetail (message required)
 *   POST /:merchantId/status                   risk        Merchant (restrict / suspend / reinstate)
 *
 * Staff-only and cross-tenant: `pz_staff_session` via StaffGuard, no `@MerchantScoped()`. The
 * class-level `@StaffOnly()` admits any operator; the mutations narrow it to `risk` (`admin`
 * passes every check). Every mutation writes `staff_audit_log` — the decisions inside their own
 * transaction (`OnboardingService.decide`), the rest through `@AuditLog`. `:merchantId` is also
 * what StaffGuard records as the acting merchant on the principal and in that trail.
 */
import { pipeline } from 'node:stream/promises';

import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';

import type {
  AdminMerchantDetail,
  AdminMerchantSummary,
  AuthPrincipal,
  Merchant,
  MerchantId,
  Paginated,
} from '@payzeno/contracts';

import type { AuthenticatedRequest } from '../auth/guards/base-auth.guard';
import { StaffGuard } from '../auth/guards/staff.guard';
import { staffIdOf } from '../auth/principal/principal.factory';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { StaffOnly } from '../common/decorators/staff-only.decorator';
import { PermissionDeniedException } from '../common/errors/auth.exceptions';
import type { StaffActor } from '../onboarding/onboarding.service';
import type { OnboardingDecision } from '../onboarding/state/onboarding.state-machine';
import { OnboardingService } from '../onboarding/onboarding.service';

import { AdminMerchantsService } from './admin-merchants.service';
import { AdminMerchantListQueryDto, AdminMerchantStatusDto, OnboardingDecisionDto } from './dto/admin.dto';

/** The part of an express response the document route writes to. */
interface DocumentResponse extends NodeJS.WritableStream {
  setHeader(name: string, value: string): void;
}

@Controller('v1/admin/merchants')
@UseGuards(StaffGuard)
@StaffOnly()
export class AdminMerchantsController {
  constructor(
    private readonly admin: AdminMerchantsService,
    private readonly onboarding: OnboardingService,
  ) {}

  @Get()
  async list(@Query() query: AdminMerchantListQueryDto): Promise<Paginated<AdminMerchantSummary>> {
    return this.admin.list({ ...query, limit: query.effectiveLimit() });
  }

  @Get(':merchantId')
  async detail(@Param('merchantId') merchantId: MerchantId): Promise<AdminMerchantDetail> {
    return this.admin.detail(merchantId);
  }

  /**
   * Streams the object from the private bucket with its own content type, `inline`, so the
   * browser opening this URL in a tab (same origin, the staff cookie rides along) is the viewer.
   * Reads are audited too: a KYC document is a passport, and "who looked at it" is a question.
   */
  @Get(':merchantId/documents/:documentId/content')
  @AuditLog('kyc_document.view', { resourceType: 'kyc_document', idParam: 'documentId' })
  async documentContent(
    @Param('merchantId') merchantId: MerchantId,
    @Param('documentId') documentId: string,
    @Res() response: DocumentResponse,
  ): Promise<void> {
    const { document, object } = await this.onboarding.readDocument(merchantId, documentId);

    response.setHeader('Content-Type', document.contentType);
    response.setHeader('Content-Length', String(object.contentLength ?? document.sizeBytes));
    response.setHeader('Content-Disposition', contentDisposition(document.filename));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    await pipeline(object.body, response);
  }

  @Post(':merchantId/onboarding/approve')
  @HttpCode(200)
  @StaffOnly('risk')
  @Idempotent()
  async approve(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Req() request: AuthenticatedRequest,
    @Param('merchantId') merchantId: MerchantId,
    @Body() body: OnboardingDecisionDto,
  ): Promise<AdminMerchantDetail> {
    return this.decide(principal, request, merchantId, 'approve', body);
  }

  @Post(':merchantId/onboarding/reject')
  @HttpCode(200)
  @StaffOnly('risk')
  @Idempotent()
  async reject(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Req() request: AuthenticatedRequest,
    @Param('merchantId') merchantId: MerchantId,
    @Body() body: OnboardingDecisionDto,
  ): Promise<AdminMerchantDetail> {
    return this.decide(principal, request, merchantId, 'reject', body);
  }

  @Post(':merchantId/onboarding/request-info')
  @HttpCode(200)
  @StaffOnly('risk')
  @Idempotent()
  async requestInfo(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Req() request: AuthenticatedRequest,
    @Param('merchantId') merchantId: MerchantId,
    @Body() body: OnboardingDecisionDto,
  ): Promise<AdminMerchantDetail> {
    return this.decide(principal, request, merchantId, 'request-info', body);
  }

  /**
   * Restrict, suspend, reinstate. `reason` lands in `staff_audit_log.reason` and in
   * `merchant.status_changed`. A `pending_review` / `rejected` merchant answers 409 `conflict`
   * (`details.reason = onboarding_decision_required`).
   */
  @Post(':merchantId/status')
  @HttpCode(200)
  @StaffOnly('risk')
  @Idempotent()
  @AuditLog('merchant.status.change', { resourceType: 'merchant', idParam: 'merchantId' })
  async changeStatus(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('merchantId') merchantId: MerchantId,
    @Body() body: AdminMerchantStatusDto,
  ): Promise<Merchant> {
    return this.admin.changeStatus(merchantId, body, requireStaffId(principal));
  }

  private decide(
    principal: AuthPrincipal,
    request: AuthenticatedRequest,
    merchantId: MerchantId,
    decision: OnboardingDecision,
    body: OnboardingDecisionDto,
  ): Promise<AdminMerchantDetail> {
    const staff: StaffActor = { staffId: requireStaffId(principal), ip: request.ip ?? null };
    return this.admin.decide(merchantId, decision, body.message ?? null, staff);
  }
}

function requireStaffId(principal: AuthPrincipal): string {
  const staffId = staffIdOf(principal);
  if (!staffId) throw new PermissionDeniedException('Staff session required');
  return staffId;
}

/** RFC 6266: an ASCII fallback plus the UTF-8 original. Quotes and newlines cannot break out. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
