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
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import type { AuthPrincipal } from '@payzeno/contracts';

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
  onModuleInit(): void {
    this.intents = this.moduleRef.get(PaymentIntentRepository, { strict: false });
  }

}
