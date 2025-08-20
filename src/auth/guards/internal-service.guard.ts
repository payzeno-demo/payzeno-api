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
  }
}
