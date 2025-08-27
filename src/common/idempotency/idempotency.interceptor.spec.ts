import { Reflector } from '@nestjs/core';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';

import type { ApiConfig } from 'src/config/api-config.type';
import { IDEMPOTENT_KEY } from 'src/common/decorators/idempotent.decorator';
import { InvalidRequestException } from 'src/common/errors/api.exception';
import {
  IdempotencyInProgressException,
  IdempotencyKeyReuseException,
} from 'src/common/errors/idempotency.exceptions';
import {
  IdempotencyInterceptor,
  POSTGRES_IDEMPOTENCY_STORE,
  REDIS_IDEMPOTENCY_STORE,
} from 'src/common/idempotency/idempotency.interceptor';
import type { IdempotencyStore } from 'src/common/idempotency/idempotency.store';
import { NoopLogger } from 'src/common/logging/logger';

import { makeApiKeyPrincipal, makeInternalPrincipal } from 'test/factories/principal.factory';
import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The interceptor's placement in the chain is what this file protects: it runs *after*
 * the auth guards (it needs `principal.merchant_id` to scope the key) and *before*
 * `ValidationPipe`, so a replay never re-runs validation on a body that once succeeded.
 */
describe('IdempotencyInterceptor', () => {
  let reflector: Reflector;
  let redis: jest.Mocked<IdempotencyStore>;
  let interceptor: IdempotencyInterceptor;
  let response: { statusCode: number; headers: Record<string, string>; status: jest.Mock; setHeader: jest.Mock };

  it('reads the decorator metadata off both the handler and the class', async () => {
    const spy = jest.spyOn(reflector, 'getAllAndOverride');

    await interceptor.intercept(context(baseRequest), handler());

    expect(spy).toHaveBeenCalledWith(IDEMPOTENT_KEY, expect.any(Array));
  });

});
