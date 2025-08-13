import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import {
  API_VERSION_KEY,
  DEFAULT_API_VERSION,
  KNOWN_API_VERSIONS,
} from 'src/common/decorators/api-version.decorator';
import { InvalidRequestException } from 'src/common/errors/api.exception';
import {
  API_VERSION_HEADER,
  ApiVersionInterceptor,
  DOWNGRADES,
} from 'src/common/interceptors/api-version.interceptor';

import { makeCharge } from 'test/factories/charge.factory';

/**
 * Date-pinned response shaping (docs/api/versioning.md).
 *
 * Downgrades only. A caller pinned to a version newer than we ship is a caller with a
 * typo, and the right answer is a 400 rather than a guess — a silently-accepted future
 * version is how a merchant ships against a shape that does not exist.
 */
describe('ApiVersionInterceptor', () => {
  let reflector: Reflector;
  let interceptor: ApiVersionInterceptor;

  function context(headerValue?: string, declared = DEFAULT_API_VERSION): ExecutionContext {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(declared);
    const headers: Record<string, string> = {};
    if (headerValue !== undefined) {
      headers[API_VERSION_HEADER] = headerValue;
    }
    return {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    } as unknown as ExecutionContext;
  }

  function handler(body: unknown): CallHandler {
    return { handle: () => of(body) };
  }

  beforeEach(() => {
    reflector = new Reflector();
    interceptor = new ApiVersionInterceptor(reflector);
  });

  it('reads the declared version off the handler and the class', async () => {
    const spy = jest.spyOn(reflector, 'getAllAndOverride');

    await firstValueFrom(interceptor.intercept(context(), handler({})));

    expect(spy).toHaveBeenCalledWith(API_VERSION_KEY, expect.any(Array));
  });

  it('passes the body through untouched when the caller sends no pin', async () => {
    const charge = makeCharge();

    await expect(
      firstValueFrom(interceptor.intercept(context(), handler(charge))),
    ).resolves.toEqual(charge);
  });

  it('passes through when the pin matches the declared version', async () => {
    const charge = makeCharge();

    await expect(
      firstValueFrom(interceptor.intercept(context('2026-01-15'), handler(charge))),
    ).resolves.toEqual(charge);
  });

  it('rejects an unknown version with a 400', async () => {
    expect(() => interceptor.intercept(context('2030-01-01'), handler({}))).toThrow(
      InvalidRequestException,
    );
  });

  it('names the supported versions in the rejection', () => {
    try {
      interceptor.intercept(context('nonsense'), handler({}));
      throw new Error('expected a rejection');
    } catch (err) {
      for (const version of KNOWN_API_VERSIONS) {
        expect((err as Error).message).toContain(version);
      }
    }
  });

  describe('downgrades', () => {
    it('flattens the nested card block for a pre-2026-01-15 caller', async () => {
      const body = {
        id: 'ch_1',
        card: { brand: 'visa', last_four: '4242', exp_month: 11, exp_year: 2029 },
      };

      const result = (await firstValueFrom(
        interceptor.intercept(context('2025-11-20'), handler(body)),
      )) as Record<string, unknown>;

      expect(result.card).toBeUndefined();
      expect(result).toMatchObject({
        card_brand: 'visa',
        card_last_four: '4242',
        card_exp_month: 11,
        card_exp_year: 2029,
      });
    });

    it('leaves a body with no card block alone', () => {
      const downgrade = DOWNGRADES['2026-01-15']!;

      expect(downgrade({ id: 'pi_1' })).toEqual({ id: 'pi_1' });
    });

    it('drops liability_shifted for a 2025-06-01 caller', () => {
      const downgrade = DOWNGRADES['2025-11-20']!;

      expect(downgrade({ id: 'dp_1', liability_shifted: true })).toEqual({ id: 'dp_1' });
    });

    it('applies the chain newest-first down to the caller’s pin', async () => {
      const body = {
        id: 'dp_1',
        liability_shifted: true,
        card: { brand: 'visa', last_four: '4242', exp_month: 1, exp_year: 2030 },
      };

      const result = (await firstValueFrom(
        interceptor.intercept(context('2025-06-01'), handler(body)),
      )) as Record<string, unknown>;

      expect(result.card).toBeUndefined();
      expect(result.card_brand).toBe('visa');
      expect(result.liability_shifted).toBeUndefined();
    });

    it('never upgrades — every declared downgrade only removes or flattens', () => {
      for (const downgrade of Object.values(DOWNGRADES)) {
        const before = { id: 'x', card: { brand: 'visa', last_four: '4242' }, liability_shifted: true };
        const after = downgrade!(before) as Record<string, unknown>;

        expect(Object.keys(after).length).toBeLessThanOrEqual(Object.keys(before).length + 4);
      }
    });

    it('has an entry for every version except the oldest', () => {
      const downgradable = KNOWN_API_VERSIONS.slice(1);

      for (const version of downgradable) {
        expect(DOWNGRADES[version]).toBeDefined();
      }
    });
  });

  it('takes the first value of a repeated version header', async () => {
    const headers = { [API_VERSION_HEADER]: ['2026-01-15', '2025-06-01'] };
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(DEFAULT_API_VERSION);
    const ctx = {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ headers }) }),
    } as unknown as ExecutionContext;

    await expect(firstValueFrom(interceptor.intercept(ctx, handler({ id: 'x' })))).resolves.toEqual({
      id: 'x',
    });
  });
});
