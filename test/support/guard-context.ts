/**
 * A minimal `ExecutionContext` for the nine guard specs.
 *
 * Guards are the one layer that cannot be tested by calling a method with arguments: they
 * read a request off `switchToHttp()`, decorator metadata off `getHandler()`/`getClass()`,
 * and write headers onto `switchToHttp().getResponse()`. Every guard spec was building its
 * own three-deep object literal and they had drifted — one of them spelled `params` as
 * `param` and the merchant-scope spec silently stopped asserting the 404 branch for a
 * release.
 *
 * The shape here matches `AuthenticatedRequest` in `src/auth/guards/base-auth.guard.ts`
 * exactly, and the reflector double reads the same metadata keys Nest's `Reflector` would,
 * so a spec that passes here fails for a real reason and not for a fixture reason.
 */
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import type { AuthPrincipal } from '@payzeno/contracts';

import type { AuthenticatedRequest } from 'src/auth/guards/base-auth.guard';

export interface RequestOverrides {
  method?: string;
  url?: string;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  params?: Record<string, string>;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
  principal?: AuthPrincipal;
}

export interface ResponseDouble {
  setHeader: jest.Mock<void, [string, string]>;
  headers: Record<string, string>;
  status: jest.Mock;
  json: jest.Mock;
  body?: unknown;
  statusCode?: number;
}

export interface GuardHarness {
  context: ExecutionContext;
  request: AuthenticatedRequest;
  response: ResponseDouble;
}

/** A request with every field the base guard touches present and sane. */
export function makeRequest(overrides: RequestOverrides = {}): AuthenticatedRequest {
  return {
    method: overrides.method ?? 'GET',
    url: overrides.url ?? '/v1/charges',
    originalUrl: overrides.url ?? '/v1/charges',
    ip: overrides.ip ?? '198.51.100.7',
    headers: lowercaseKeys(overrides.headers ?? {}),
    cookies: overrides.cookies ?? {},
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: overrides.body,
    rawBody: overrides.rawBody,
    principal: overrides.principal,
  };
}

/** Header lookups in the guards are all lowercase; a fixture that is not is a false failure. */
function lowercaseKeys(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

export function makeResponse(): ResponseDouble {
  const headers: Record<string, string> = {};
  const response: ResponseDouble = {
    headers,
    setHeader: jest.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    status: jest.fn(function status(this: ResponseDouble, code: number) {
      response.statusCode = code;
      return response;
    }),
    json: jest.fn((body: unknown) => {
      response.body = body;
    }),
  };
  return response;
}

/**
 * The handler/class pair a guard reflects on. Two distinct function objects so a spec can
 * tell handler-level metadata from controller-level metadata — `@StaffOnly` on one route of
 * a controller whose other routes are session-auth is a real shape in this repo
 * (`SettlementsController`).
 */
export function makeExecutionContext(
  request: AuthenticatedRequest,
  response: ResponseDouble = makeResponse(),
): GuardHarness {
  const handler = function handler(): void {};
  const controller = class TestController {};

  const context = {
    switchToHttp: () => ({
      getRequest: <T>() => request as unknown as T,
      getResponse: <T>() => response as unknown as T,
      getNext: () => undefined,
    }),
    getHandler: () => handler,
    getClass: () => controller,
    getType: () => 'http',
    getArgs: () => [request, response],
    getArgByIndex: (index: number) => [request, response][index],
    switchToRpc: () => {
      throw new Error('not an rpc context');
    },
    switchToWs: () => {
      throw new Error('not a ws context');
    },
  } as unknown as ExecutionContext;

  return { context, request, response };
}

/** Shorthand: build both halves in one call. */
export function guardContext(overrides: RequestOverrides = {}): GuardHarness {
  return makeExecutionContext(makeRequest(overrides));
}

/**
 * A `Reflector` double keyed exactly like Nest's. `getAllAndOverride` returns the first
 * defined value across the targets it is given, which is the semantic the guards rely on
 * when a handler overrides its controller.
 */
export function makeReflector(metadata: Record<string | symbol, unknown> = {}): Reflector {
  return {
    get: (key: string | symbol) => metadata[key],
    getAll: (key: string | symbol) => [metadata[key]],
    getAllAndOverride: (key: string | symbol) => metadata[key],
    getAllAndMerge: (key: string | symbol) => metadata[key] ?? [],
  } as unknown as Reflector;
}

/** Assert a promise rejects with a specific exception class, and hand the error back. */
export async function rejectsWith<T extends Error>(
  promise: Promise<unknown>,
  type: new (...args: never[]) => T,
): Promise<T> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(type);
    return err as T;
  }
  throw new Error(`expected the call to reject with ${type.name}, but it resolved`);
}
