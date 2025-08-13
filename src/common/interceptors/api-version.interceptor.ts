/**
 * ApiVersionInterceptor — date-pinned response shaping.
 *
 * A handler declares, with `@ApiVersion('2026-01-15')`, the version at which its current
 * response shape became correct. A request pinned to an older `Payzeno-Version` goes through
 * the downgrade chain: each entry knows how to turn version N into version N-1, and they are
 * applied newest-first until the caller's pin is reached.
 *
 * Downgrades, never upgrades. A caller pinned to a version newer than we ship is a caller
 * with a typo, and we tell them so rather than guessing. docs/api/versioning.md.
 */
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';

import {
  API_VERSION_KEY,
  DEFAULT_API_VERSION,
  isKnownApiVersion,
  KNOWN_API_VERSIONS,
  type ApiVersionDate,
} from '../decorators/api-version.decorator';
import { InvalidRequestException } from '../errors/api.exception';

export const API_VERSION_HEADER = 'payzeno-version';

/** Turns a version-N body into a version-(N-1) body. Keyed by the version being left. */
export type Downgrade = (body: Record<string, unknown>) => Record<string, unknown>;

export const DOWNGRADES: Readonly<Partial<Record<ApiVersionDate, Downgrade>>> = {
  /** 2026-01-15 nested the card fields; before it they were flat `card_*` keys. */
  '2026-01-15': (body) => {
    const card = body.card as Record<string, unknown> | undefined;
    if (!card) return body;

    const { card: _dropped, ...rest } = body;
    return {
      ...rest,
      card_brand: card.brand,
      card_last_four: card.last_four,
      card_exp_month: card.exp_month,
      card_exp_year: card.exp_year,
    };
  },
  /** 2025-11-20 added `liability_shifted` on disputes; older clients never saw it. */
  '2025-11-20': (body) => {
    const { liability_shifted: _dropped, ...rest } = body;
    return rest;
  },
};

@Injectable()
export class ApiVersionInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const declared =
      this.reflector.getAllAndOverride<ApiVersionDate | undefined>(API_VERSION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_API_VERSION;

    const requested = this.requestedVersion(context);

    if (requested === declared) return next.handle();

    return next.handle().pipe(map((body) => downgradeTo(body, declared, requested)));
  }

  private requestedVersion(context: ExecutionContext): ApiVersionDate {
    const headers = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>()
      .headers;
    const raw = headers[API_VERSION_HEADER];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (!value) return DEFAULT_API_VERSION;
    if (!isKnownApiVersion(value)) {
      throw new InvalidRequestException(
        `Unknown Payzeno-Version '${value}'. Supported: ${KNOWN_API_VERSIONS.join(', ')}`,
      );
    }
    return value;
  }
}

/** Applies every downgrade strictly between `requested` and `from`, newest first. */
export function downgradeTo(body: unknown, from: ApiVersionDate, requested: ApiVersionDate): unknown {
  if (!body || typeof body !== 'object') return body;

  const fromIndex = KNOWN_API_VERSIONS.indexOf(from);
  const toIndex = KNOWN_API_VERSIONS.indexOf(requested);
  if (toIndex >= fromIndex) return body;

  let current = body as Record<string, unknown>;

  for (let i = fromIndex; i > toIndex; i -= 1) {
    const step = DOWNGRADES[KNOWN_API_VERSIONS[i]];
    if (step) current = step(current);
  }

  return current;
}
