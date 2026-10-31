/**
 * `/v1/onboarding` — the signed-in merchant's KYC checklist, RFC platform-v2 §3. Session-only:
 * onboarding is a console workflow, and an API key has no business submitting a passport.
 *
 *   GET    /v1/onboarding             any role   Onboarding
 *   PATCH  /v1/onboarding             owner|admin  business profile + representative
 *   POST   /v1/onboarding/documents   owner|admin  201 KycDocument (base64 ≤ 600 KB decoded)
 *   POST   /v1/onboarding/submit      owner|admin  collecting|needs_info → submitted
 *
 * Edits and uploads are refused with 409 `invalid_state` while a reviewer has the application
 * (`submitted`) and after a decision; `submit` is refused with 409 `invalid_state`,
 * `details.reason = requirements_due`, while anything is still due. The bank-account
 * requirement is met through the existing `POST /v1/bank-accounts`.
 */
import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from '@nestjs/common';

import type { AuthPrincipal, KycDocument, Onboarding } from '@payzeno/contracts';

import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { BaseController } from '../common/base/base.controller';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { Roles } from '../common/decorators/roles.decorator';

import { UpdateOnboardingDto, UploadKycDocumentDto } from './dto/onboarding.dto';
import { OnboardingService } from './onboarding.service';

@Controller('v1/onboarding')
@MerchantScoped()
@UseGuards(SessionGuard, MerchantScopeGuard, RolesGuard)
export class OnboardingController extends BaseController {
  constructor(private readonly onboarding: OnboardingService) {
    super();
  }

  @Get()
  async get(@CurrentPrincipal() principal: AuthPrincipal): Promise<Onboarding> {
    return this.onboarding.get(this.merchantIdOf(principal));
  }

  @Patch()
  @Roles('owner', 'admin')
  @Idempotent()
  @AuditLog('onboarding.update', { resourceType: 'onboarding' })
  async update(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: UpdateOnboardingDto,
  ): Promise<Onboarding> {
    return this.onboarding.update(this.merchantIdOf(principal), body);
  }

  @Post('documents')
  @HttpCode(201)
  @Roles('owner', 'admin')
  @Idempotent()
  @AuditLog('kyc_document.upload', { resourceType: 'kyc_document' })
  async uploadDocument(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() body: UploadKycDocumentDto,
  ): Promise<KycDocument> {
    const uploadedBy = principal.kind === 'dashboard_session' ? principal.user_id : null;
    return this.onboarding.uploadDocument(this.merchantIdOf(principal), body, uploadedBy);
  }

  @Post('submit')
  @HttpCode(200)
  @Roles('owner', 'admin')
  @Idempotent()
  @AuditLog('onboarding.submit', { resourceType: 'onboarding' })
  async submit(@CurrentPrincipal() principal: AuthPrincipal): Promise<Onboarding> {
    return this.onboarding.submit(this.merchantIdOf(principal));
  }
}
