/**
 * Both passes of domain-model.md §11.2 over a JSON-shaped value: the field denylist (cheap,
 * exact, key-based), then the Luhn scan over whatever strings are left.
 *
 * RedactionInterceptor applies it to request and response bodies; AuditLogInterceptor applies
 * it to the `after` state it persists, which it reads before the response pass has run.
 */
import { maskPans } from './pan.matcher';
import { NO_EXEMPTIONS, redactDeep } from './redaction.denylist';

const MAX_DEPTH = 12;

/**
 * A client secret inside a longer string. The hosted checkout `url` carries the session secret
 * in its fragment (`…/c/cs_…#cs_…_secret_…`), where the key-based denylist cannot see it.
 */
const EMBEDDED_CLIENT_SECRET = /\b((?:cs|pi)_[0-9A-HJKMNP-TV-Z]{26}_secret_)[A-Za-z0-9]+/g;

/** `exempt` spares a route's own credentials from the denylist pass only — never from the PAN scan. */
export function scrubDeep(value: unknown, exempt: ReadonlySet<string> = NO_EXEMPTIONS): unknown {
  return mapStrings(redactDeep(value, 0, exempt), maskPans, 0);
}

/**
 * The audit pass: `scrubDeep`, then client secrets embedded in strings. Not for responses —
 * a merchant creating a checkout session needs the hosted `url` intact; `audit_log.after`
 * needs nothing that would let a reader pay as, or read, that session.
 */
export function scrubForAudit(value: unknown): unknown {
  return mapStrings(
    scrubDeep(value),
    (s) => s.replace(EMBEDDED_CLIENT_SECRET, '$1[REDACTED]'),
    0,
  );
}

function mapStrings(value: unknown, fn: (s: string) => string, depth: number): unknown {
  if (depth > MAX_DEPTH || value === null || value === undefined) return value;

  if (typeof value === 'string') return fn(value);

  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = mapStrings(child, fn, depth + 1);
    }
    return out;
  }

  return value;
}
