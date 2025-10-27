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

/** Shorthand: build both halves in one call. */
export function guardContext(overrides: RequestOverrides = {}): GuardHarness {
  return makeExecutionContext(makeRequest(overrides));
}

/**
 * A `Reflector` double keyed exactly like Nest's. `getAllAndOverride` returns the first
 * defined value across the targets it is given, which is the semantic the guards rely on
 * when a handler overrides its controller.
 */
