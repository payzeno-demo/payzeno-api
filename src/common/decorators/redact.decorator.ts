/**
 * `@Redact('card_number','cvv',…)` — DTO-level redaction hints, arc PCI.
 *
 * The global denylist in redaction.denylist.ts covers the 16 universal field names. This
 * decorator covers the DTO-specific ones: a field that is only sensitive in one request
 * shape, and nested paths the flat denylist cannot express.
 *
 * Sites: CreateBankAccountDto, ConfirmPaymentIntentDto, CreateWebhookEndpointDto.
 */
import 'reflect-metadata';

export const REDACT_KEY = 'payzeno:redact';

export function Redact(...paths: string[]): ClassDecorator {
  return (target) => {
    const existing = (Reflect.getMetadata(REDACT_KEY, target) as string[] | undefined) ?? [];
    Reflect.defineMetadata(REDACT_KEY, [...new Set([...existing, ...paths])], target);
  };
}

