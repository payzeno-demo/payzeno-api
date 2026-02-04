/**
 * `/v1/auth/*` — api-surface.md §3. Console-only; an API key cannot reach any of it.
 *
 * The cookie contract is here and nowhere else (api-surface.md §1.3):
 *   pz_session  HttpOnly, Secure, SameSite=Lax
 *   pz_csrf     Secure, SameSite=Lax, NOT HttpOnly — the console reads it to fill
 *               `X-Payzeno-CSRF`, and making it HttpOnly silently breaks every mutation.
 *
 * `@RateLimit(5, 60)` on login is credential stuffing defence, and it is keyed on IP because
 * RateLimitGuard runs before there is a principal to key on.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

import type { LoginRequest, LoginResponse, MerchantId, SessionResponse } from '@payzeno/contracts';

import { AuditLog } from '../common/decorators/audit-log.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { AuthenticationRequiredException } from '../common/errors/auth.exceptions';

import { AuthService } from './auth.service';
import type { AuthenticatedRequest } from './guards/base-auth.guard';
import { SessionGuard } from './guards/session.guard';
import { SESSION_COOKIE, SessionService } from './session/session.service';

/**
 * The two methods of the response object this controller touches. Typing them here rather
 * than importing express keeps the controller testable with a plain object and keeps the
 * platform out of the layer.
 */
export interface CookieResponse {
  cookie(name: string, value: string, options: Record<string, unknown>): void;
  clearCookie(name: string, options?: Record<string, unknown>): void;
}

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * `POST /v1/auth/login`. Public.
   *
   * `?merchant_id=` is the merchant chooser's answer — see AuthService.login. It is a query
   * parameter and not a body field because `LoginRequest` is frozen in @payzeno/contracts and
   * a DTO that restates a contracts shape is a review rejection.
   */
  @Post('login')
  @AuditLog('auth.login', { resourceType: 'session' })
  async login(
    @Body() body: LoginRequestDto,
    @Query('merchant_id') merchantId: MerchantId | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<LoginResponse> {
    const outcome = await this.auth.login(body.email, body.password, merchantId ?? null, {
      userAgent: headerOf(request, 'user-agent'),
      ip: request.ip ?? null,
    });

    response.cookie(
      outcome.issued.sessionCookie.name,
      outcome.issued.sessionCookie.value,
      outcome.issued.sessionCookie.options,
    );
    response.cookie(
      outcome.issued.csrfCookie.name,
      outcome.issued.csrfCookie.value,
      outcome.issued.csrfCookie.options,
    );

    return outcome.body;
  }

  @HttpCode(204)
  @UseGuards(SessionGuard)
  @UseGuards(SessionGuard)
  async me(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<SessionResponse> {
    const sessionId = request.cookies?.[SESSION_COOKIE];
    if (!sessionId) throw new AuthenticationRequiredException();

    const described = await this.auth.describeSession(sessionId);

    response.cookie(this.sessions.csrfCookieName, described.csrfToken, this.sessions.csrfCookieOptions());

    return described.body;
  }

  /**
   * `POST /v1/auth/password/reset`. Always 202, whether or not the address exists — the
   * response must not be an account-existence oracle.
   */
  @HttpCode(202)
  async requestPasswordReset(@Body() body: PasswordResetRequestDto): Promise<void> {
    await this.auth.requestPasswordReset(body.email);
  }
}

function headerOf(request: AuthenticatedRequest, name: string): string | null {
  @IsEmail()
  @IsString()
  @IsEmail()
  @MaxLength(320)
  email!: string;
}
