/**
 * `/v1/admin/*` — the back office's platform-wide queues (RFC platform-v2 §1).
 *
 *   GET  /v1/admin/disputes                         risk      Paginated<Dispute>, every merchant
 *   GET  /v1/admin/settlements/backlog              finance   ReconciliationBacklog (ledger)
 *   GET  /v1/admin/support-tasks                    support   Paginated<SupportTask>
 *   POST /v1/admin/support-tasks/:taskId/resolve    support   SupportTask
 *   GET  /v1/admin/emails?to=&merchant_id=&template= support  Paginated<EmailMessage>
 *
 * The actions on disputes and settlement items stay on their existing routes
 * (`POST /v1/disputes/:id/accept?merchant_id=`, `POST /v1/settlements/:b/items/:i/retry
 * ?merchant_id=`); those are merchant-scoped and need the acting merchant named.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';

import type { AuthPrincipal, Dispute, EmailMessage, Paginated, ReconciliationBacklog, SupportTask } from '@payzeno/contracts';

import { StaffGuard } from '../auth/guards/staff.guard';
import { staffIdOf } from '../auth/principal/principal.factory';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { StaffOnly } from '../common/decorators/staff-only.decorator';
import { PermissionDeniedException } from '../common/errors/auth.exceptions';
import { EmailService } from '../notifications/email/email.service';

import { AdminOperationsService } from './admin-operations.service';
import {
  AdminDisputeListQueryDto,
  AdminEmailLookupQueryDto,
  AdminSupportTaskListQueryDto,
  ResolveSupportTaskDto,
  SettlementBacklogQueryDto,
} from './dto/admin.dto';

@Controller('v1/admin')
@UseGuards(StaffGuard)
@StaffOnly()
export class AdminOperationsController {
  constructor(
    private readonly operations: AdminOperationsService,
    private readonly email: EmailService,
  ) {}

  @Get('disputes')
  @StaffOnly('risk')
  async disputes(@Query() query: AdminDisputeListQueryDto): Promise<Paginated<Dispute>> {
    return this.operations.listDisputes(
      { status: query.status, merchantId: query.merchant_id },
      { limit: query.effectiveLimit(), cursor: query.cursor },
    );
  }

  @Get('settlements/backlog')
  @StaffOnly('finance')
  async settlementBacklog(@Query() query: SettlementBacklogQueryDto): Promise<ReconciliationBacklog> {
    return this.operations.settlementBacklog(query);
  }

  @Get('support-tasks')
  @StaffOnly('support')
  async supportTasks(@Query() query: AdminSupportTaskListQueryDto): Promise<Paginated<SupportTask>> {
    return this.operations.listSupportTasks(
      { status: query.status, kind: query.kind, merchantId: query.merchant_id },
      { limit: query.effectiveLimit(), cursor: query.cursor },
    );
  }

  /** 404 for an unknown task, 409 `conflict` for one that is already resolved or dismissed. */
  @Post('support-tasks/:taskId/resolve')
  @HttpCode(200)
  @StaffOnly('support')
  @AuditLog('support_task.resolve', { resourceType: 'support_task', idParam: 'taskId' })
  async resolveSupportTask(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('taskId') taskId: string,
    @Body() body: ResolveSupportTaskDto,
  ): Promise<SupportTask> {
    const staffId = staffIdOf(principal);
    if (!staffId) throw new PermissionDeniedException('Staff session required');
    return this.operations.resolveSupportTask(taskId, body.note?.trim() || null, staffId);
  }

  /** Support's "did we email them?". Metadata only — never a body, never the link inside it. */
  @Get('emails')
  @StaffOnly('support')
  async emails(@Query() query: AdminEmailLookupQueryDto): Promise<Paginated<EmailMessage>> {
    return this.email.lookup(
      { to: query.to, merchantId: query.merchant_id, template: query.template },
      { limit: query.effectiveLimit(), cursor: query.cursor },
    );
  }
}
