/**
 * The 16-name field denylist — arc PCI, domain-model.md §11.2.
 *
 * The regex alone is not enough and the reason is specific: a 9-digit ABA routing number is
 * not Luhn-valid and is not in the 13-19 digit band, so `pan.matcher.ts` never caught it.
 * Raw routing and account numbers went into structured request logs, into
 * `field_errors[].path`, and into APM traces. That is PAY-1740 and it is why this list exists
 * as well as why bank details are tokenised at the vault (domain-model.md §11.3).
 *
 * Matched case-insensitively, at any depth, on the KEY — never on the value.
 */
import type { LogContext } from '../logging/logger';

export const REDACTED = '[REDACTED]';

export const REDACTION_DENYLIST: ReadonlySet<string> = new Set([
  'account_number',
  'routing_number',
  'iban',
  'sort_code',
  'cvv',
  'cvc',
  'card_number',
  'pan',
  'track1',
  'track2',
  'track_data',
  'password',
  'secret',
  'signing_secret',
  'client_secret',
  'api_key',
]);

export function isDeniedField(fieldName: string): boolean {
  return REDACTION_DENYLIST.has(fieldName.toLowerCase());
}

/**
 * Redacts a dotted path used in `ValidationError.field_errors[].path`. The path itself is
 * safe; what is not safe is a path *segment* that names a denied field appearing next to the
 * offending value in the same error object, so the segment is replaced.
 */
export function redactPath(path: string): string {
  return path
    .split('.')
    .map((segment) => (isDeniedField(segment) ? REDACTED : segment))
    .join('.');
}

/** Flat scrub for a LogContext. Deep structures never reach the logger by contract. */
export function redactLogContext(ctx: LogContext): LogContext {
  const out: LogContext = {};
  for (const [key, value] of Object.entries(ctx)) {
    out[key] = isDeniedField(key) ? REDACTED : value;
  }
  return out;
}

/**
 * Deep, structure-preserving scrub used on request and response bodies by
 * RedactionInterceptor. Arrays keep their length — a merchant debugging a 422 needs to know
 * which element failed.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 12 || value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, depth + 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isDeniedField(key) ? REDACTED : redactDeep(child, depth + 1);
    }
    return out;
  }

  return value;
}
