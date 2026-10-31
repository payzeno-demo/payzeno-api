/**
 * Where Payzeno sends a browser or a webhook: `return_url`, checkout `success_url` /
 * `cancel_url` / `allowed_origin`, and webhook endpoint URLs.
 *
 * The DTOs accept http and https and leave the scheme to this check, because the rule depends
 * on the environment and a class-validator decorator cannot see `ApiConfig`. Production requires
 * https. Every other environment also accepts http: the local demo shops are
 * `http://<slug>.shop.localhost:3000` and receive their webhooks at `http://sim-shops:3000/...`,
 * and there is no certificate to present on either.
 */
import type { NodeEnv } from '../../config/api-config.type';
import { ValidationException } from '../errors/api.exception';

export interface CallbackUrlOptions {
  /** Scheme + host (+ port) and nothing else — the embedded checkout's `allowed_origin`. */
  originOnly?: boolean;
}

export function allowsPlainHttp(nodeEnv: NodeEnv): boolean {
  return nodeEnv !== 'production';
}

/** Parses `value` and refuses it when its scheme is not allowed here. Returns the parsed URL. */
export function assertCallbackUrl(
  value: string,
  path: string,
  nodeEnv: NodeEnv,
  options: CallbackUrlOptions = {},
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ValidationException(`${path} is not a valid absolute URL`, [
      { path, code: 'invalid_format', message: 'must be an absolute URL' },
    ]);
  }

  const httpAllowed = allowsPlainHttp(nodeEnv);
  if (parsed.protocol !== 'https:' && !(httpAllowed && parsed.protocol === 'http:')) {
    throw new ValidationException(`${path} must be https`, [
      {
        path,
        code: 'invalid_scheme',
        message: httpAllowed ? 'must be http or https' : 'https is required',
      },
    ]);
  }

  if (options.originOnly && value.replace(/\/$/, '') !== parsed.origin) {
    throw new ValidationException(`${path} must be an origin`, [
      { path, code: 'invalid_format', message: 'scheme, host and port only — no path, query or fragment' },
    ]);
  }

  return parsed;
}
