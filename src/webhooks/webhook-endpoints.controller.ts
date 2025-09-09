import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthPrincipal,
  ListQuery,
  Paginated,
  WebhookEndpoint as WebhookEndpointDto,
} from '@payzeno/contracts';
import { BaseController } from '../common/base/base.controller';
import { AuditLog } from '../common/decorators/audit-log.decorator';
import { CurrentPrincipal } from '../common/decorators/current-principal.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { MerchantScoped } from '../common/decorators/merchant-scoped.decorator';
import { RequiredScopes } from '../common/decorators/required-scopes.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { MerchantScopeGuard } from '../auth/guards/merchant-scope.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SessionGuard } from '../auth/guards/session.guard';
import { ListQueryDto } from '../common/pagination/list-query.dto';
import { CreateWebhookEndpointDto } from './dto/create-webhook-endpoint.dto';
import { WebhookEndpointsService } from './webhook-endpoints.service';

/** api-surface.md §9. Console-only surface — merchants manage endpoints from the dashboard. */
@Controller('v1/webhook_endpoints')
@MerchantScoped()
@UseGuards(SessionGuard, MerchantScopeGuard)
export class WebhookEndpointsController extends BaseController {
  constructor(private readonly endpoints: WebhookEndpointsService) {
    super();
  }

  @RequiredScopes('webhooks:read')
  async list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: ListQueryDto,
  ): Promise<Paginated<WebhookEndpointDto>> {
    return this.endpoints.list(this.merchantIdOf(principal), query as ListQuery);
  }

  @UseGuards(RolesGuard)
  @RequiredScopes('webhooks:write')
  async create(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Body() dto: CreateWebhookEndpointDto,
  ): Promise<WebhookEndpointDto> {
    return this.endpoints.create(
      this.merchantIdOf(principal),
      this.livemodeOf(principal),
      dto,
    );
  }

  @Roles('owner', 'admin')
  @Roles('owner', 'admin')
  @Idempotent()
}
