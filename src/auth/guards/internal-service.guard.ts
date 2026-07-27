/**
 * InternalServiceGuard — the `/internal/v1/*` surface (api-surface.md §9b).
 *
 * Three things must all hold:
 *
 *   1. `X-Payzeno-Service` names a service we know (`payzeno-ledger`,
 *      `payzeno-billing-legacy`);
 *   2. `X-Payzeno-Internal-Secret` matches `INTERNAL_API_SECRET`, compared in constant time;
 *   3. the handler's `@InternalOnly(...)` allowlist, when it names callers, contains that
 *      service. `POST /internal/v1/charges/:id/settled` is the ledger's alone — the Java
 *      biller has no business marking a charge settled.
 *
 * mTLS is the fourth, and it is terminated at nginx (`nginx/payzeno-internal.conf`, port
 * 8081, internal network only) rather than here — Node would have to re-verify a chain the
 * proxy already verified. That is why the deny rule on the PUBLIC listener matters so much:
 * it is the only thing standing between the open internet and a shared secret.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthPrincipal } from '@payzeno/contracts';

import {
  INTERNAL_ONLY_KEY,
  type InternalCaller,
  type InternalOnlySpec,
} from '../../common/decorators/internal-only.decorator';
import { AuthenticationRequiredException, PermissionDeniedException } from '../../common/errors/auth.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../../common/logging/logger';
import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';
import { ApiKeyHasher } from '../api-key/api-key.hasher';
import { PrincipalFactory } from '../principal/principal.factory';

import { BaseAuthGuard, type AuthenticatedRequest } from './base-auth.guard';

export const SERVICE_HEADER = 'x-payzeno-service';
export const INTERNAL_SECRET_HEADER = 'x-payzeno-internal-secret';

const KNOWN_CALLERS: readonly InternalCaller[] = ['payzeno-ledger', 'payzeno-billing-legacy'];

@Injectable()
export class InternalServiceGuard extends BaseAuthGuard {
  protected readonly scheme = 'internal';

  private readonly sharedSecret: string;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly principals: PrincipalFactory,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {
    super();
    this.sharedSecret = config.ledger.internalApiSecret;
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    if (principal?.kind !== 'internal_service') {
      throw new PermissionDeniedException('Internal surface requires an internal service principal');
    }

    const spec = this.reflector.getAllAndOverride<InternalOnlySpec | undefined>(INTERNAL_ONLY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (spec && spec.callers.length > 0 && !spec.callers.includes(principal.service)) {
      this.logger.warn('internal.caller_not_allowed', {
        service: principal.service,
        allowed: spec.callers.join(','),
      });
      throw new PermissionDeniedException(`${principal.service} may not call this route`, {
        service: principal.service,
      });
    }

    return true;
  }

  protected async authenticate(request: AuthenticatedRequest): Promise<AuthPrincipal | null> {
    const service = this.header(request, SERVICE_HEADER);
    const secret = this.header(request, INTERNAL_SECRET_HEADER);

    if (!service && !secret) return null;

    if (!service || !KNOWN_CALLERS.includes(service as InternalCaller)) {
      throw new AuthenticationRequiredException('Unknown or missing X-Payzeno-Service');
    }

    if (!secret || !ApiKeyHasher.constantTimeEquals(secret, this.sharedSecret)) {
      // Logged at warn: a wrong secret on the internal listener is either a rotation that
      // half-landed or something that should not be able to reach this port at all.
      this.logger.warn('internal.secret_mismatch', { service });
      throw new AuthenticationRequiredException('Invalid internal service credential');
    }

    return this.principals.fromInternalService(service as InternalCaller, ['internal:read', 'internal:write']);
  }
}
