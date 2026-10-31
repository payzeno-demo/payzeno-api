/**
 * `@AcceptsSecretFields(...)` / `@ReturnsSecretFields(...)` — the credentials a route exists to
 * receive or to hand out, exempted from RedactionInterceptor on that route and nowhere else.
 *
 * The denylist redacts by key, at any depth, in both directions. That is right for card and
 * bank data, which Payzeno never takes or returns in plaintext. It is wrong for the handful of
 * credentials that are the route's whole purpose: login cannot verify a password it only ever
 * sees as '[REDACTED]', and a browser cannot confirm a PaymentIntent whose `client_secret` came
 * back redacted. Without these, every login failed and the API key secret, the webhook signing
 * secret and every client secret were unreadable at the one moment they are shown.
 *
 * Only credential names are exemptable. The type admits no card or bank field, so no route can
 * opt out of arc PCI by decoration.
 *
 * What still reads a request body after the interceptor, and why an accepted `password` is safe
 * there: AuditLogInterceptor reads `reason` and nothing else, and the idempotency fingerprint
 * runs only on `@Idempotent()` routes, which login is not. Logs never carry bodies.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export type ExemptableSecretField = 'password' | 'client_secret' | 'secret' | 'signing_secret';

export const ACCEPTS_SECRET_FIELDS_KEY = 'payzeno:accepts_secret_fields';
export const RETURNS_SECRET_FIELDS_KEY = 'payzeno:returns_secret_fields';

type AtLeastOne<T> = [T, ...T[]];

/** The request body may carry these to the handler unredacted. */
export const AcceptsSecretFields = (...fields: AtLeastOne<ExemptableSecretField>): CustomDecorator =>
  SetMetadata(ACCEPTS_SECRET_FIELDS_KEY, fields);

/** The response body may carry these to the caller unredacted. */
export const ReturnsSecretFields = (...fields: AtLeastOne<ExemptableSecretField>): CustomDecorator =>
  SetMetadata(RETURNS_SECRET_FIELDS_KEY, fields);
