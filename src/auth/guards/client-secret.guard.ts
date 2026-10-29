/**
 * ClientSecretGuard — the browser-side checkout credential.
 *
 * `Authorization: Bearer <payment_intent.client_secret>` resolves to a principal scoped to
 * exactly ONE PaymentIntent. There is no merchant-wide read behind it: the value lives in the
 * customer's browser, on the merchant's checkout page, and anything it can reach is
 * effectively public.
 *
 * The guard therefore does two things a normal guard does not:
 *
 *   1. it pins the principal to the intent the secret belongs to, and
 *   2. it refuses when the route's `:paymentIntentId` is a different intent — otherwise one
 *      customer's client secret reads another customer's payment on the same merchant.
 */
import { Injectable, type ExecutionContext, type OnModuleInit } from '@nestjs/common';
import { ModuleRef, Reflector } from '@nestjs/core';

import type { AuthPrincipal } from '@payzeno/contracts';

import { ACCEPTS_CLIENT_SECRET_KEY } from '../../common/decorators/accepts-client-secret.decorator';
import { AuthenticationRequiredException, PermissionDeniedException } from '../../common/errors/auth.exceptions';
import { PaymentIntentRepository } from '../../payments/payment-intent.repository';
import { PrincipalFactory } from '../principal/principal.factory';

import { BaseAuthGuard, type AuthenticatedRequest } from './base-auth.guard';

/** `pi_<ULID>_secret_<random>`. Minted by PaymentIntentsService, stored on the row. */
const CLIENT_SECRET_PREFIX = 'pi_';
const CLIENT_SECRET_MARKER = '_secret_';

@Injectable()
export class ClientSecretGuard extends BaseAuthGuard implements OnModuleInit {
  protected readonly scheme = 'client-secret';

  /**
   * Resolved through `ModuleRef` rather than injected, for the same reason the bus consumers
   * do it (docs/adr/0009-event-consumer-wiring.md): `PaymentsModule` imports `AuthModule` to
   * get this guard, so `AuthModule` cannot import `PaymentsModule` to get the repository.
   * The lookup happens once, after the whole graph exists.
   */
  private intents!: PaymentIntentRepository;

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly principals: PrincipalFactory,
    private readonly reflector: Reflector,
  ) {
    super();
  }

  onModuleInit(): void {
    this.intents = this.moduleRef.get(PaymentIntentRepository, { strict: false });
  }

  /** Only handlers marked `@AcceptsClientSecret()`; everywhere else a secret is ignored. */
  protected override appliesTo(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean | undefined>(ACCEPTS_CLIENT_SECRET_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }

  protected async authenticate(request: AuthenticatedRequest): Promise<AuthPrincipal | null> {
    const token = this.bearerToken(request);

    if (!token || !token.startsWith(CLIENT_SECRET_PREFIX) || !token.includes(CLIENT_SECRET_MARKER)) {
      return null;
    }

    const intent = await this.intents.findByClientSecret(token);
    if (!intent) {
      // Same class, same message as a missing credential: a valid-shaped secret that resolves
      // to nothing must not be distinguishable from one that was never issued.
      throw new AuthenticationRequiredException('Invalid client secret');
    }

    this.assertRouteMatches(request, intent.id);

    // The intent's own mode — a test-mode intent's secret must scope to test-mode rows.
    return this.principals.fromClientSecret(intent.merchantId, intent.id, intent.livemode);
  }

  private assertRouteMatches(request: AuthenticatedRequest, intentId: string): void {
    const routeId = request.params.paymentIntentId;
    if (routeId && routeId !== intentId) {
      throw new PermissionDeniedException('This client secret does not belong to that payment intent', {
        reason: 'client_secret_scope',
      });
    }
  }
}
