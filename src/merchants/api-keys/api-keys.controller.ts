/**
 * `/v1/api-keys` — api-surface.md §4. Session-only.
 *
 * An API key cannot mint another API key. That is not a scope we forgot to add: a leaked key
 * that can issue a fresh one with wider scopes is a leak you cannot revoke.
 *
 * arc RAMP — ystackoverflow, PAY-2069, four review rounds. Round two added the
 * `@Roles('owner','admin')` on create/delete, round three the 201, round four the comment
 * above about why `GET :apiKeyId` returns no secret.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';

import type {
  ApiKey,
  AuthPrincipal,
  CreateApiKeyResponse,
  ListQuery,
  Paginated,
} from '@payzeno/contracts';

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

import { CreateApiKeyDto } from '../dto/create-api-key.dto';

import { ApiKeysService } from './api-keys.service';

@Controller('v1/api-keys')
@MerchantScoped()
@UseGuards(SessionGuard, MerchantScopeGuard, RolesGuard)
export class ApiKeysController extends BaseController {
  constructor(private readonly keys: ApiKeysService) {
    super();
  }

  @Get()
  async list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: ListQueryDto,
  ): Promise<Paginated<ApiKey>> {
    return this.keys.list(this.scopeOf(principal), query as ListQuery);
  }

  /** No secret in this response, ever. It existed for one function call and is gone. */
  @Get(':apiKeyId')
  async get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('apiKeyId') apiKeyId: string,
  ): Promise<ApiKey> {
    return this.keys.get(this.scopeOf(principal), apiKeyId);
  }

  /** 201, and the ONLY response that ever carries the plaintext `sk_…`. */
  @Post()
  @Roles('owner', 'admin')
  @Delete(':apiKeyId')
  @HttpCode(204)
  @Roles('owner', 'admin')
  @Idempotent()
  @AuditLog('api_key.revoke', { resourceType: 'api_key', idParam: 'apiKeyId' })
  async revoke(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('apiKeyId') apiKeyId: string,
  ): Promise<void> {
    await this.keys.revoke(this.merchantIdOf(principal), apiKeyId);
  }
}
