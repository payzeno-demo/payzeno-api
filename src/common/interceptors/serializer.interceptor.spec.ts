import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import { SerializerInterceptor, serialize } from 'src/common/interceptors/serializer.interceptor';

import { makeCharge } from 'test/factories/charge.factory';

/**
 * Last link before `HttpExceptionFilter`.
 *
 * The `undefined → null` rule is the one that matters. `JSON.stringify` drops undefined
 * keys silently, so an optional field ends up sometimes absent and sometimes null
 * depending on how the object was built — and every consumer then writes
 * `x.field ?? null` defensively. The contract says nullable fields are present and null.
 */
describe('SerializerInterceptor', () => {
  const interceptor = new SerializerInterceptor();
  const context = {} as ExecutionContext;

  function handler(body: unknown): CallHandler {
    return { handle: () => of(body) };
  }

  it('passes a plain object through', async () => {
    await expect(
      firstValueFrom(interceptor.intercept(context, handler({ id: 'ch_1', amount_minor: 4_500 }))),
    ).resolves.toEqual({ id: 'ch_1', amount_minor: 4_500 });
  });

  it('calls toResponse() on anything that has one', async () => {
    const entity = {
      internalColumn: 'not for the wire',
      toResponse: () => ({ object: 'charge', id: 'ch_1' }),
    };

    await expect(firstValueFrom(interceptor.intercept(context, handler(entity)))).resolves.toEqual({
      object: 'charge',
      id: 'ch_1',
    });
  });

  it('calls toResponse() on every element of a list', async () => {
    const entities = [
      { toResponse: () => ({ id: 'ch_1' }) },
      { toResponse: () => ({ id: 'ch_2' }) },
    ];

    await expect(firstValueFrom(interceptor.intercept(context, handler(entities)))).resolves.toEqual(
      [{ id: 'ch_1' }, { id: 'ch_2' }],
    );
  });

  it('serialises a Paginated envelope, entities and all', async () => {
    const page = {
      data: [{ toResponse: () => ({ id: 'ch_1' }) }],
      next_cursor: null,
      has_more: false,
    };

    await expect(firstValueFrom(interceptor.intercept(context, handler(page)))).resolves.toEqual({
      data: [{ id: 'ch_1' }],
      next_cursor: null,
      has_more: false,
    });
  });
});

describe('serialize', () => {
  it('turns undefined into null', () => {
    expect(serialize({ next_action: undefined })).toEqual({ next_action: null });
  });

  it('turns a top-level undefined into null', () => {
    expect(serialize(undefined)).toBeNull();
  });

  it('keeps an explicit null', () => {
    expect(serialize({ canceled_at: null })).toEqual({ canceled_at: null });
  });

  it('formats a Date as RFC 3339', () => {
    expect(serialize(new Date('2026-01-15T12:00:00.000Z'))).toBe('2026-01-15T12:00:00.000Z');
  });

  it('formats nested Dates', () => {
    expect(serialize({ created_at: new Date('2026-01-15T12:00:00.000Z') })).toEqual({
      created_at: '2026-01-15T12:00:00.000Z',
    });
  });

  it('recurses into nested objects', () => {
    expect(
      serialize({ card: { brand: 'visa', country: undefined }, metadata: {} }),
    ).toEqual({ card: { brand: 'visa', country: null }, metadata: {} });
  });

  it('recurses into arrays of objects', () => {
    expect(serialize([{ a: undefined }, { a: 1 }])).toEqual([{ a: null }, { a: 1 }]);
  });

  it('leaves a fully-populated contracts object untouched', () => {
    const charge = makeCharge();

    expect(serialize(charge)).toEqual(charge);
  });

  it('preserves integers rather than stringifying them', () => {
    expect(serialize({ amount_minor: 4_500 })).toEqual({ amount_minor: 4_500 });
  });

  it('preserves booleans', () => {
    expect(serialize({ livemode: false })).toEqual({ livemode: false });
  });

  it('preserves an empty array', () => {
    expect(serialize({ data: [] })).toEqual({ data: [] });
  });

  it('bounds recursion rather than blowing the stack', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 40; i += 1) {
      deep = { nested: deep };
    }

    expect(() => serialize(deep)).not.toThrow();
  });

  it('unwraps a toResponse() that itself returns entities', () => {
    const inner = { toResponse: () => ({ id: 'ch_1' }) };
    const outer = { toResponse: () => ({ charge: inner, amount_minor: undefined }) };

    expect(serialize(outer)).toEqual({ charge: { id: 'ch_1' }, amount_minor: null });
  });
});
