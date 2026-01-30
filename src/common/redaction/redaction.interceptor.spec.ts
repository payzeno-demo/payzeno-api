import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';

import type { ApiConfig } from 'src/config/api-config.type';
import { REDACTED } from 'src/common/redaction/redaction.denylist';
import { REDACTED_PAN } from 'src/common/redaction/pan.matcher';
import { RedactionInterceptor } from 'src/common/redaction/redaction.interceptor';

/**
 * arc PCI's enforcement point. Two passes, in order: the field denylist (cheap, exact,
 * key-based) and then a Luhn scan over whatever strings are left.
 *
 * The in-place mutation of `req.body` is deliberate and is asserted here: the audit
 * interceptor, the idempotency fingerprint and the access log all read `req.body` after
 * this interceptor runs. Redacting a copy would leave three readers looking at the
 * original — which is exactly how the PAN reached the structured logs the first time.
 */
describe('RedactionInterceptor', () => {
  function config(redact = true): ApiConfig {
    return { flags: { redactPanInLogs: redact } } as unknown as ApiConfig;
  }

  function context(request: Record<string, unknown>): ExecutionContext {
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
  }

  function handler(body: unknown): CallHandler {
    return { handle: () => of(body) };
  }

  const interceptor = new RedactionInterceptor(config());

  describe('the field denylist', () => {
    it.each([
      'account_number',
      'routing_number',
      'iban',
      'sort_code',
      'cvv',
      'cvc',
      'card_number',
      'pan',
      'password',
      'secret',
      'signing_secret',
      'client_secret',
      'api_key',
    ])('redacts %s', (field) => {
      const scrubbed = interceptor.scrub({ [field]: 'sensitive-value' }) as Record<string, unknown>;

      expect(scrubbed[field]).toBe(REDACTED);
    });

    it('matches case-insensitively', () => {
      const scrubbed = interceptor.scrub({ CVV: '123', Card_Number: '4242424242424242' }) as Record<
        string,
        unknown
      >;

      expect(scrubbed.CVV).toBe(REDACTED);
      expect(scrubbed.Card_Number).toBe(REDACTED);
    });

    it('redacts at depth', () => {
      const scrubbed = interceptor.scrub({
        payment_method: { card: { cvv: '123', last_four: '4242' } },
      }) as { payment_method: { card: Record<string, unknown> } };

      expect(scrubbed.payment_method.card.cvv).toBe(REDACTED);
      expect(scrubbed.payment_method.card.last_four).toBe('4242');
    });

    it('redacts inside arrays and keeps the array length', () => {
      const scrubbed = interceptor.scrub({ description: 'order 4471' }) as Record<string, unknown>;

      expect(scrubbed.description).toBe('order 4471');
    });
  });

  describe('interception', () => {
    it('scrubs the request body in place, so later readers see the scrubbed value', async () => {
      const off = new RedactionInterceptor(config(false));
      const result = await firstValueFrom(off.intercept(context(req), handler({ cvv: '123' })));

      expect((req.body as Record<string, unknown>).cvv).toBe('123');
      expect(result).toEqual({ cvv: '123' });
    });
  });

  it('preserves primitives and nulls', () => {
    expect(interceptor.scrub(null)).toBeNull();
    expect(interceptor.scrub(42)).toBe(42);
    expect(interceptor.scrub(true)).toBe(true);
    expect(interceptor.scrub('plain string')).toBe('plain string');
  });
});
