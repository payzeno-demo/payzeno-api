/**
 * ApiKeyGuard — `Authorization: Bearer sk_live_… / sk_test_…`.
 *
 * The lookup is O(1) and the verify is constant-time; both live in ApiKeyResolver. What the
 * guard adds is the scope check, because `@RequiredScopes(...)` is metadata on the handler
 * and only a guard can read it.
 *
 * Chain: canActivate → ApiKeyResolver.resolve → ApiKeyHasher.lookupHash → repo.findOne
 *        → ApiKeyHasher.verifySecret → PrincipalFactory.fromApiKey
 */
import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { ApiKeyScope, AuthPrincipal } from '@payzeno/contracts';

import { REQUIRED_SCOPES_KEY } from '../../common/decorators/required-scopes.decorator';
import { PermissionDeniedException } from '../../common/errors/auth.exceptions';
import { ApiKeyResolver } from '../api-key/api-key.resolver';
import { coversRequired, firstMissingScope } from '../api-key/api-key.scopes';

import { BaseAuthGuard, type AuthenticatedRequest } from './base-auth.guard';

@Injectable()
export class ApiKeyGuard extends BaseAuthGuard {
  protected readonly scheme = 'apikey';

  constructor(
    private readonly resolver: ApiKeyResolver,
    private readonly reflector: Reflector,
  ) {
    super();
  }

  /**
   * Overridden to run the scope check after the base has attached the principal. The base
   * cannot do it: scopes are per-handler metadata and only this guard's kind of principal
   * carries them.
   */
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const activated = await super.canActivate(context);
    if (!activated) return false;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    if (principal?.kind === 'api_key') {
      this.assertScopes(context, principal.scopes);
    }

    return true;
  }

  protected async authenticate(request: AuthenticatedRequest): Promise<AuthPrincipal | null> {
    const token = this.bearerToken(request);

    // Not our credential — a session cookie or a client secret. Let the next guard try.
    if (!token || !token.startsWith('sk_')) return null;

    return this.resolver.resolve(token);
  }

  private assertScopes(context: ExecutionContext, granted: readonly ApiKeyScope[]): void {
    const required = this.reflector.getAllAndOverride<ApiKeyScope[] | undefined>(
      REQUIRED_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) return;
    if (coversRequired(granted, required)) return;

    throw PermissionDeniedException.missingScope(firstMissingScope(granted, required) ?? required[0]);
  }
}
