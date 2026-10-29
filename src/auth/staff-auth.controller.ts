/**
 * `/v1/staff/auth/*` — the admin back office's session (RFC platform-v2 §1).
 *
 * The cookie contract, as for the console:
 *   pz_staff_session  HttpOnly, Secure (production), SameSite=Lax
 *   pz_csrf           readable, echoed in `X-Payzeno-CSRF` on every mutation
 *
 * The admin app is its own origin (`admin.payzeno.com`, locally `http://admin.localhost`), so
 * its `pz_csrf` never collides with the console's. Staff credentials live in `staff_user` and
 * nowhere else; a merchant login cannot authenticate here and an operator cannot sign in to the
 * console with these routes.
 *
 * `@RateLimit(5, 60)` on login for the same reason as `/v1/auth/login`: credential stuffing.
 */
import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

import type { StaffLoginRequest, StaffSessionResponse } from '@payzeno/contracts';

import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { AcceptsSecretFields } from '../common/decorators/secret-fields.decorator';
import { StaffOnly } from '../common/decorators/staff-only.decorator';
import { AuthenticationRequiredException } from '../common/errors/auth.exceptions';

import { AuthService } from './auth.service';
import type { AuthenticatedRequest } from './guards/base-auth.guard';
import { StaffGuard } from './guards/staff.guard';
import {
  originOf,
  SessionService,
  STAFF_SESSION_COOKIE,
  writeSessionCookies,
  type CookieResponse,
} from './session/session.service';

export class StaffLoginRequestDto implements StaffLoginRequest {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;
}

@Controller('v1/staff/auth')
export class StaffAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /** `401 authentication_required` for an unknown operator, a wrong password or a disabled account alike. */
  @Post('login')
  @HttpCode(200)
  @RateLimit(5, 60)
  @AcceptsSecretFields('password')
  async login(
    @Body() body: StaffLoginRequestDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<StaffSessionResponse> {
    const outcome = await this.auth.loginStaff(body.email, body.password, originOf(request));

    writeSessionCookies(response, outcome.issued);
    return outcome.body;
  }

  /** 204. Clears `pz_staff_session` and `pz_csrf` with the flags they were set with. */
  @Post('logout')
  @HttpCode(204)
  @UseGuards(StaffGuard)
  @StaffOnly()
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    await this.auth.logout(request.cookies?.[STAFF_SESSION_COOKIE]);

    for (const expired of this.sessions.expiredCookies(STAFF_SESSION_COOKIE)) {
      response.clearCookie(expired.name, expired.options);
    }
  }

  /** The admin app's bootstrap call. 401 means "not signed in". Refreshes `pz_csrf`. */
  @Get('me')
  @UseGuards(StaffGuard)
  @StaffOnly()
  async me(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<StaffSessionResponse> {
    const sessionId = request.cookies?.[STAFF_SESSION_COOKIE];
    if (!sessionId) throw new AuthenticationRequiredException();

    const described = await this.auth.describeStaffSession(sessionId);
    response.cookie(this.sessions.csrfCookieName, described.csrfToken, this.sessions.csrfCookieOptions());

    return described.body;
  }
}
