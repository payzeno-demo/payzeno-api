import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthPrincipal,
  ListQuery,
  Paginated,
  PublicEventType,
  WebhookEvent as WebhookEventDto,
  WebhookEventStatus,
} from '@payzeno/contracts';
import { BaseController } from '../common/base/base.controller';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { StaffOnly } from '../common/decorators/staff-only.decorator';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { ListQueryDto } from '../common/pagination/list-query.dto';
import { WebhookEventsService } from './webhook-events.service';

/**
 * api-surface.md §9. Read-only for the merchant plus one operational escape hatch.
 *
 * `GET /v1/webhook_events/:eventId` was ystackoverflow's route (arc RAMP, month 11, three
 * review rounds — the first two were about whether the 404 should leak that the id exists
 * for another merchant. It should not.)
 */
@Controller('v1/webhook_events')
@MerchantScoped()
@UseGuards(SessionGuard, MerchantScopeGuard)
export class WebhookEventsController extends BaseController {
  constructor(private readonly events: WebhookEventsService) {
    super();
  }

  @Get()
  @RequiredScopes('webhooks:read')
  async list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: ListQueryDto,
    @Query('status') status?: WebhookEventStatus,
    @Query('type') type?: PublicEventType,
  ): Promise<Paginated<WebhookEventDto>> {
    return this.events.list(this.merchantIdOf(principal), {
      ...(query as ListQuery),
      status,
      type,
    });
  }

  @Get(':eventId')
  @RequiredScopes('webhooks:read')
  async get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('eventId') eventId: string,
  ): Promise<WebhookEventDto> {
    return this.events.get(this.merchantIdOf(principal), eventId);
  }

  /**
   * Merchant admins and Payzeno support can both force a redelivery. Support uses it most
   * — it is step 3 of docs/runbooks/webhook-delivery.md.
   */
  @Post(':eventId/redeliver')
  @StaffOnly('support')
  @Idempotent()
  @AuditLog('webhook_event.redeliver')
  @RequiredScopes('webhooks:write')
  async redeliver(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('eventId') eventId: string,
  ): Promise<WebhookEventDto> {
    return this.events.redeliver(this.merchantIdOf(principal), eventId);
  }
}
