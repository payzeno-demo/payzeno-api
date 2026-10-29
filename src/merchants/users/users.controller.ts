/**
 * `/v1/merchants/:merchantId/users` — api-surface.md §4.
 *
 * Session-only. There is no api-key path to the user list on purpose: a server-side
 * integration has no business enumerating a merchant's staff, and `merchants:read` would have
 * granted it if the routes shared a controller.
 */
import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

import { USER_ROLES } from '@payzeno/contracts';
import type { AuthPrincipal, ListQuery, MerchantId, Paginated, User, UserId, UserRole } from '@payzeno/contracts';

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

import { MerchantUsersService } from './users.service';

export class InviteUserDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(140)
  full_name!: string;

  @IsIn([...USER_ROLES])
  role!: UserRole;
}

export class ChangeUserRoleDto {
  @IsIn([...USER_ROLES])
  role!: UserRole;
}

@Controller('v1/merchants/:merchantId/users')
@MerchantScoped({ idParam: 'merchantId' })
@UseGuards(SessionGuard, MerchantScopeGuard, RolesGuard)
export class MerchantUsersController extends BaseController {
  constructor(private readonly users: MerchantUsersService) {
    super();
  }

  @Get()
  async list(
    @Param('merchantId') merchantId: MerchantId,
    @Query() query: ListQueryDto,
  ): Promise<Paginated<User>> {
    return this.users.list(merchantId, query as ListQuery);
  }

  @Get(':userId')
  async get(
    @Param('merchantId') merchantId: MerchantId,
    @Param('userId') userId: UserId,
  ): Promise<User> {
    return this.users.get(merchantId, userId);
  }

  /** Sends `team_invite` (RFC platform-v2 §4). Re-inviting a still-`invited` address re-sends. */
  @Post()
  @Roles('owner', 'admin')
  @Idempotent()
  @AuditLog('merchant_user.invite', { resourceType: 'merchant_user' })
  async invite(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('merchantId') merchantId: MerchantId,
    @Body() body: InviteUserDto,
  ): Promise<User> {
    const invitedBy = principal.kind === 'dashboard_session' ? principal.user_id : null;
    return this.users.invite(merchantId, body, invitedBy);
  }

  @Post(':userId/role')
  @Roles('owner')
  @Idempotent()
  @AuditLog('merchant_user.change_role', { resourceType: 'merchant_user', idParam: 'userId' })
  async changeRole(
    @Param('merchantId') merchantId: MerchantId,
    @Param('userId') userId: UserId,
    @Body() body: ChangeUserRoleDto,
  ): Promise<User> {
    return this.users.changeRole(merchantId, userId, body.role);
  }

  @Delete(':userId')
  @HttpCode(204)
  @Roles('owner', 'admin')
  @Idempotent()
  @AuditLog('merchant_user.remove', { resourceType: 'merchant_user', idParam: 'userId' })
  async remove(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Param('merchantId') merchantId: MerchantId,
    @Param('userId') userId: UserId,
  ): Promise<void> {
    const actingUserId = principal.kind === 'dashboard_session' ? principal.user_id : null;
    await this.users.remove(merchantId, userId, actingUserId);
  }
}
