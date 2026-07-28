/**
 * ProcessorSignatureGuard — `webhook-sig` auth, for `POST /v1/webhooks/:acquirer`.
 *
 * The acquirer has no Payzeno credential: it signs the raw body with a shared secret and we
 * verify the HMAC. Three properties, all of which the verifier owns and none of which are
 * negotiable:
 *
 *   - the signature is over the RAW bytes, before any JSON parse. `rawBody` is captured by
 *     the body parser for this route only (see main.ts) — re-serialising the parsed object
 *     and signing that is how key ordering silently breaks every webhook.
 *   - the comparison is constant time.
 *   - the timestamp is checked against a tolerance, so a captured request cannot be replayed
 *     next week.
 *
 * There is no principal for this scheme: nothing downstream of the webhook controller is
 * merchant-scoped by the caller, it is scoped by the charge the event refers to. The guard
 * returns true or throws, and attaches nothing.
 */
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { ACQUIRERS } from '@payzeno/contracts';
import type { Acquirer } from '@payzeno/contracts';

import { AuthenticationRequiredException } from '../../common/errors/auth.exceptions';
import { ProcessorSignatureVerifier } from '../../payments/processor/processor-signature.verifier';

import { headerValue, type AuthenticatedRequest } from './base-auth.guard';

export const SIGNATURE_HEADER = 'x-payzeno-acquirer-signature';

@Injectable()
export class ProcessorSignatureGuard implements CanActivate, OnModuleInit {
  /** Resolved late: `PaymentsModule` owns the verifier and consumes this guard. ADR 0009. */
  private verifier!: ProcessorSignatureVerifier;

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit(): void {
    this.verifier = this.moduleRef.get(ProcessorSignatureVerifier, { strict: false });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    const acquirer = this.acquirerOf(request);
    const signature = headerValue(request.headers[SIGNATURE_HEADER]);

    if (!signature) {
      throw new AuthenticationRequiredException('Missing acquirer signature header', {
        acquirer,
      });
    }

    if (!request.rawBody) {
      // A route reaching here without rawBody is a body-parser wiring bug, and verifying the
      // re-serialised object instead would be a silent downgrade to no verification at all.
      throw new AuthenticationRequiredException('Raw body unavailable for signature verification');
    }

    this.verifier.assertValid(acquirer, request.rawBody, signature);
    return true;
  }

  private acquirerOf(request: AuthenticatedRequest): Acquirer {
    const raw = request.params.acquirer;

    if (!raw || !(ACQUIRERS as readonly string[]).includes(raw)) {
      throw new AuthenticationRequiredException(`Unknown acquirer '${raw ?? ''}'`);
    }

    return raw as Acquirer;
  }
}
