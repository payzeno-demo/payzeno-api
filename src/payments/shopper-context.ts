/**
 * Who is paying, as far as the edge can tell. RFC platform-v2 §7–§9. L0, pure.
 *
 * The country comes from `X-Payzeno-Geo-Country`, which only the pay host sets (CloudFront's
 * viewer country in AWS, nginx's simulated GeoIP map locally) and only on `/v1/checkout/`.
 * Outside production the checkout page may also send `X-Payzeno-Geo-Override` (from its
 * `?country=` query) so a demo can be a shopper from anywhere; production ignores it.
 *
 * The address is the first `X-Forwarded-For` hop — the same hop nginx geolocates — and is only
 * used for the distinct-cards-per-address velocity signal. Never the socket address: behind
 * nginx that is nginx, and every shopper sharing one address would trip the velocity rule.
 * Neither value is trusted for anything that moves money on its own: they are risk signals
 * and a pricing hint.
 */
import type { NodeEnv } from '../config/api-config.type';

export const GEO_COUNTRY_HEADER = 'x-payzeno-geo-country';
export const GEO_OVERRIDE_HEADER = 'x-payzeno-geo-override';

export interface ShopperContext {
  /** ISO 3166-1 alpha-2, upper case, or null when the edge did not say. */
  country: string | null;
  ip: string | null;
}

export const UNKNOWN_SHOPPER: ShopperContext = { country: null, ip: null };

type HeaderBag = Record<string, string | string[] | undefined>;

const COUNTRY = /^[A-Z]{2}$/;
const IP = /^[0-9a-fA-F:.]{3,45}$/;

function first(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined ? null : raw.trim();
}

function country(value: string | string[] | undefined): string | null {
  const candidate = first(value)?.toUpperCase() ?? null;
  return candidate && COUNTRY.test(candidate) ? candidate : null;
}

export function shopperContextFrom(headers: HeaderBag, nodeEnv: NodeEnv): ShopperContext {
  const override = nodeEnv === 'production' ? null : country(headers[GEO_OVERRIDE_HEADER]);
  const forwarded = first(headers['x-forwarded-for'])?.split(',')[0]?.trim() ?? null;

  return {
    country: override ?? country(headers[GEO_COUNTRY_HEADER]),
    ip: forwarded && IP.test(forwarded) ? forwarded : null,
  };
}
