/**
 * `/v1/signup` — merchant self-signup, RFC platform-v2 §3. Both routes are public: there is no
 * session yet, and the emailed token is the only credential `verify` takes.
 *
 *   POST /v1/signup         201 SignupResponse. Merchant `pending_review`, owner `invited`,
 *                           `signup_verify` emailed. Never logs anyone in.
 *   POST /v1/signup/verify  200 LoginResponse. Spends the token, activates the owner, and sets
 *                           `pz_session` + `pz_csrf` exactly like `POST /v1/auth/login`.
 *                           400 `invalid_request`, `details.reason` = `token_invalid` |
 *                           `token_expired`, for a bad link.
 *
 * Not `@Idempotent()`: there is no principal to scope a key to, and a replayed signup is
 * already refused by the legal-name uniqueness check (422 on `legal_name`).
 */
import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';

import type { LoginResponse, SignupResponse } from '@payzeno/contracts';

import { AuthService } from '../auth/auth.service';
import type { AuthenticatedRequest } from '../auth/guards/base-auth.guard';
import { originOf, writeSessionCookies, type CookieResponse } from '../auth/session/session.service';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { AcceptsSecretFields } from '../common/decorators/secret-fields.decorator';

import { SignupRequestDto, VerifyEmailDto } from './dto/onboarding.dto';
import { SignupService } from './signup.service';

@Controller('v1/signup')
export class SignupController {
  constructor(
    private readonly signups: SignupService,
    private readonly auth: AuthService,
  ) {}

  @Post()
  @HttpCode(201)
  @RateLimit(10, 60)
  @AcceptsSecretFields('password')
  async signup(@Body() body: SignupRequestDto): Promise<SignupResponse> {
    return this.signups.signup(body);
  }

  @Post('verify')
  @HttpCode(200)
  @RateLimit(10, 60)
  async verify(
    @Body() body: VerifyEmailDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<LoginResponse> {
    const outcome = await this.auth.verifyEmail(body.token, originOf(request));

    writeSessionCookies(response, outcome.issued);
    return outcome.body;
  }
}
