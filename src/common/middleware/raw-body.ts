/**
 * Which requests keep their raw body bytes through the JSON parser (`main.ts`'s `verify` hook).
 *
 * Only the acquirer webhooks: `ProcessorSignatureGuard` HMACs the bytes exactly as they arrived,
 * and `ProcessorWebhookController` is mounted at `v1/processor/webhooks`. The prefix used to be
 * `/v1/webhooks/`, which matches no route, so every acquirer webhook reached the guard without a
 * raw body and was refused with a 401.
 */
export const RAW_BODY_PATH_PREFIX = '/v1/processor/webhooks/';

export function keepsRawBody(url: string | undefined): boolean {
  return url?.startsWith(RAW_BODY_PATH_PREFIX) ?? false;
}
