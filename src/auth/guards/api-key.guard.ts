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
    const principal = request.principal;

    if (principal?.kind === 'api_key') {
      this.assertScopes(context, principal.scopes);
    }

    return true;
  }

  protected async authenticate(request: AuthenticatedRequest): Promise<AuthPrincipal | null> {
  }
}
