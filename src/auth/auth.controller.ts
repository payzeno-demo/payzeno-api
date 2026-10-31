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

import type {
  AcceptInvitationRequest,
  LoginRequest,
  LoginResponse,
  MerchantId,
  PasswordResetConfirmRequest,
  PasswordResetRequest,
  SessionResponse,
} from '@payzeno/contracts';

import { AuditLog } from '../common/decorators/audit-log.decorator';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { AcceptsSecretFields } from '../common/decorators/secret-fields.decorator';
import { AuthenticationRequiredException } from '../common/errors/auth.exceptions';

import { AuthService } from './auth.service';
import type { AuthenticatedRequest } from './guards/base-auth.guard';
import { SessionGuard } from './guards/session.guard';
import {
  originOf,
  SESSION_COOKIE,
  SessionService,
  writeSessionCookies,
  type CookieResponse,
} from './session/session.service';

/**
 * The response shape the cookie-setting controllers type against. Defined beside the cookie
 * contract in SessionService, so the staff and signup controllers share it without reaching
 * into this one; re-exported here for the callers that always imported it from this file.
 */
export type { CookieOptions, CookieResponse } from './session/session.service';

/**
 * Declared here rather than in a `dto/` folder: `src/auth` has no DTO directory by design —
 * two request shapes do not earn one. It `implements LoginRequest`; it does not restate it.
 *
 * Both DTOs sit ABOVE the controller. `emitDecoratorMetadata` writes `design:paramtypes` for
 * `login` and `requestPasswordReset` while `AuthController` is being defined, and a class
 * declared further down the file is still in its temporal dead zone at that point — the
 * module throws a ReferenceError on load.
 */
export class LoginRequestDto implements LoginRequest {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  /**
   * The maximum is not decoration. argon2 hashes whatever it is given and a 4MB "password"
   * is a free denial of service against the one endpoint that cannot be rate-limited per
   * merchant.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;
}

export class PasswordResetRequestDto implements PasswordResetRequest {
  @IsEmail()
  @MaxLength(320)
  email!: string;
}

/**
 * A password someone is CHOOSING (invite, reset, signup). Ten characters, not the eight
 * `LoginRequestDto` accepts: login has to keep accepting passwords set under the old rule.
 */
export const NEW_PASSWORD_MIN_LENGTH = 10;

/** The emailed secret: 32 random bytes, base64url — 43 characters. Bounded, not exact. */
export const LINK_TOKEN_MAX_LENGTH = 128;

export class AcceptInvitationDto implements AcceptInvitationRequest {
  @IsString()
  @MinLength(16)
  @MaxLength(LINK_TOKEN_MAX_LENGTH)
  token!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(140)
  full_name!: string;

  @IsString()
  @MinLength(NEW_PASSWORD_MIN_LENGTH)
  @MaxLength(256)
  password!: string;
}

export class PasswordResetConfirmDto implements PasswordResetConfirmRequest {
  @IsString()
  @MinLength(16)
  @MaxLength(LINK_TOKEN_MAX_LENGTH)
  token!: string;

  @IsString()
  @MinLength(NEW_PASSWORD_MIN_LENGTH)
  @MaxLength(256)
  password!: string;
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
  @HttpCode(200)
  @RateLimit(5, 60)
  @AuditLog('auth.login', { resourceType: 'session' })
  // Without this the denylist hands the handler '[REDACTED]' and no password ever verifies.
  @AcceptsSecretFields('password')
  async login(
    @Body() body: LoginRequestDto,
    @Query('merchant_id') merchantId: MerchantId | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<LoginResponse> {
    const outcome = await this.auth.login(body.email, body.password, merchantId ?? null, originOf(request));

    writeSessionCookies(response, outcome.issued);
    return outcome.body;
  }

  /** `POST /v1/auth/logout`. Clears both cookies with the same flags they were set with. */
  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  @AuditLog('auth.logout', { resourceType: 'session' })
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<void> {
    await this.auth.logout(request.cookies?.[SESSION_COOKIE]);

    for (const expired of this.sessions.expiredCookies()) {
      response.clearCookie(expired.name, expired.options);
    }
  }

  /**
   * `GET /v1/auth/me`. The console's bootstrap call — it is what tells the SPA which merchant
   * it is looking at — and it refreshes `pz_csrf` so a long-lived tab keeps a valid token.
   */
  @Get('me')
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
  @Post('password/reset')
  @HttpCode(202)
  @RateLimit(5, 60)
  async requestPasswordReset(@Body() body: PasswordResetRequestDto): Promise<void> {
    await this.auth.requestPasswordReset(body.email);
  }

  /**
   * `POST /v1/auth/password/reset/confirm`. Public; the token is the credential. 204, and no
   * session — every session of the login is revoked and the console sends the user to /login.
   * `400 invalid_request` with `details.reason` `token_invalid` | `token_expired` on a bad link.
   */
  @Post('password/reset/confirm')
  @HttpCode(204)
  @RateLimit(10, 60)
  @AcceptsSecretFields('password')
  async confirmPasswordReset(@Body() body: PasswordResetConfirmDto): Promise<void> {
    await this.auth.confirmPasswordReset(body.token, body.password);
  }

  /**
   * `POST /v1/auth/invitations/accept` (RFC platform-v2 §4). Public; the token is the
   * credential. Sets the name and password, activates the login and signs in: the response sets
   * `pz_session` + `pz_csrf` exactly like `/login` and carries the same `LoginResponse`.
   */
  @Post('invitations/accept')
  @HttpCode(200)
  @RateLimit(10, 60)
  @AcceptsSecretFields('password')
  async acceptInvitation(
    @Body() body: AcceptInvitationDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<LoginResponse> {
    const outcome = await this.auth.acceptInvitation(body.token, body.full_name, body.password, originOf(request));

    writeSessionCookies(response, outcome.issued);
    return outcome.body;
  }
}
