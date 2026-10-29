/**
 * CheckoutSecretGuard — the hosted / embedded checkout page's credential.
 *
 * `Authorization: Bearer <checkout_session.client_secret>` (`cs_<ULID>_secret_<random>`). Like
 * ClientSecretGuard it produces a `client_secret` principal pinned to ONE PaymentIntent — the
 * session's — with the session's `livemode`, and it refuses a route whose `:id` is a different
 * session. Whatever it can reach is effectively public: the secret sits in a URL fragment on the
 * shopper's machine and in the merchant's page.
 *
 * The session repository is resolved through `ModuleRef` for the same reason ClientSecretGuard
 * does it: CheckoutModule reaches this guard through the global AuthModule, so AuthModule cannot
 * import CheckoutModule back.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { AuthPrincipal } from '@payzeno/contracts';

import { CheckoutSessionRepository } from '../../checkout/checkout-session.repository';
import { AuthenticationRequiredException, PermissionDeniedException } from '../../common/errors/auth.exceptions';
import { PrincipalFactory } from '../principal/principal.factory';

import { BaseAuthGuard, type AuthenticatedRequest } from './base-auth.guard';

const SESSION_SECRET_PREFIX = 'cs_';
const SESSION_SECRET_MARKER = '_secret_';

@Injectable()
export class CheckoutSecretGuard extends BaseAuthGuard implements OnModuleInit {
  protected readonly scheme = 'checkout-secret';

  private sessions!: CheckoutSessionRepository;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly principals: PrincipalFactory,
  ) {
    super();
  }

  onModuleInit(): void {
    this.sessions = this.moduleRef.get(CheckoutSessionRepository, { strict: false });
  }

  protected async authenticate(request: AuthenticatedRequest): Promise<AuthPrincipal | null> {
    const token = this.bearerToken(request);
    if (!token || !token.startsWith(SESSION_SECRET_PREFIX) || !token.includes(SESSION_SECRET_MARKER)) {
      return null;
    }

    const session = await this.sessions.findByClientSecret(token);
    if (!session) {
      // Same answer as no credential: a well-formed secret must not reveal which sessions exist.
      throw new AuthenticationRequiredException('Invalid checkout session secret');
    }

    const routeId = request.params.id;
    if (routeId && routeId !== session.id) {
      throw new PermissionDeniedException('This secret does not belong to that checkout session', {
        reason: 'checkout_secret_scope',
      });
    }

    return this.principals.fromClientSecret(session.merchantId, session.paymentIntentId, session.livemode);
  }
}
