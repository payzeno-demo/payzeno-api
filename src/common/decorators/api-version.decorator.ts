/**
 * `@ApiVersion('2026-01-15')` — date-pinned response shaping.
 *
 * A handler declares the version at which its current shape became correct. A request with an
 * older `Payzeno-Version` header goes through ApiVersionInterceptor, which downgrades the
 * body. Default is CONTRACTS_VERSION's API_VERSION.
 *
 * Sites: ChargesController.get, PaymentIntentsController.get, DisputesController.get.
 * docs/api/versioning.md.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const API_VERSION_KEY = 'payzeno:api_version';

/** Every version Payzeno has shipped, oldest first. Adding one is a docs/api change too. */
export const KNOWN_API_VERSIONS = ['2025-06-01', '2025-11-20', '2026-01-15'] as const;
export type ApiVersionDate = (typeof KNOWN_API_VERSIONS)[number];

export const DEFAULT_API_VERSION: ApiVersionDate = '2026-01-15';

export const ApiVersion = (date: ApiVersionDate): CustomDecorator => SetMetadata(API_VERSION_KEY, date);

export function isKnownApiVersion(value: string): value is ApiVersionDate {
  return (KNOWN_API_VERSIONS as readonly string[]).includes(value);
}
