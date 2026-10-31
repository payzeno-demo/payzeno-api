import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { firstValueFrom, of } from 'rxjs';

import { AcceptsSecretFields, ReturnsSecretFields } from 'src/common/decorators/secret-fields.decorator';
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

  class PlainController {
    handle(): void {}
  }

  function context(
    request: Record<string, unknown>,
    controller: new () => object = PlainController,
    method = 'handle',
  ): ExecutionContext {
    const handler = Reflect.get(controller.prototype, method) as () => void;
    return {
      getType: () => 'http',
      getHandler: () => handler,
      getClass: () => controller,
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    } as unknown as ExecutionContext;
  }

  function handler(body: unknown): CallHandler {
    return { handle: () => of(body) };
  }

  const interceptor = new RedactionInterceptor(config(), new Reflector());

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
      const scrubbed = interceptor.scrub({
        accounts: [{ iban: 'GB33BUKB20201555555555' }, { iban: 'DE89370400440532013000' }],
      }) as { accounts: Array<Record<string, unknown>> };

      // A merchant debugging a 422 still needs to know which element failed.
      expect(scrubbed.accounts).toHaveLength(2);
      expect(scrubbed.accounts[0].iban).toBe(REDACTED);
      expect(scrubbed.accounts[1].iban).toBe(REDACTED);
    });

    it('leaves safe fields alone', () => {
      const scrubbed = interceptor.scrub({
        amount_minor: 4_500,
        currency: 'GBP',
        last_four: '4242',
        description: 'Order 4471',
      });

      expect(scrubbed).toEqual({
        amount_minor: 4_500,
        currency: 'GBP',
        last_four: '4242',
        description: 'Order 4471',
      });
    });

    it('never matches on a value — only on the key', () => {
      const scrubbed = interceptor.scrub({ description: 'my password is hunter2' }) as Record<
        string,
        unknown
      >;

      expect(scrubbed.description).toBe('my password is hunter2');
    });
  });

  describe('the PAN scan', () => {
    it('masks a PAN in a free-text field the denylist does not know about', () => {
      const scrubbed = interceptor.scrub({ description: 'card 4242424242424242' }) as Record<
        string,
        unknown
      >;

      expect(scrubbed.description).toBe(`card ${REDACTED_PAN}`);
    });

    it('masks a space-separated PAN', () => {
      const scrubbed = interceptor.scrub({ note: '4242 4242 4242 4242' }) as Record<string, unknown>;

      expect(scrubbed.note).toBe(REDACTED_PAN);
    });

    it('masks a PAN nested in metadata', () => {
      const scrubbed = interceptor.scrub({
        metadata: { customer_note: 'paid with 5555555555554444' },
      }) as { metadata: Record<string, unknown> };

      expect(scrubbed.metadata.customer_note).toContain(REDACTED_PAN);
    });

    it('leaves an order number alone', () => {
      const scrubbed = interceptor.scrub({ description: 'order 4471' }) as Record<string, unknown>;

      expect(scrubbed.description).toBe('order 4471');
    });
  });

  describe('interception', () => {
    it('scrubs the request body in place, so later readers see the scrubbed value', async () => {
      const req = {
        method: 'POST',
        originalUrl: '/v1/bank-accounts',
        body: { account_number: '00012345', currency: 'GBP' },
      };

      await firstValueFrom(await Promise.resolve(interceptor.intercept(context(req), handler({}))));

      expect((req.body as Record<string, unknown>).account_number).toBe(REDACTED);
      expect((req.body as Record<string, unknown>).currency).toBe('GBP');
    });

    it('scrubs the response body', async () => {
      const req = { method: 'GET', originalUrl: '/v1/bank-accounts', body: undefined };

      const result = await firstValueFrom(
        interceptor.intercept(context(req), handler({ iban: 'GB33BUKB20201555555555' })),
      );

      expect(result).toEqual({ iban: REDACTED });
    });

    it('handles a request with no body', async () => {
      const req = { method: 'GET', originalUrl: '/v1/charges', body: undefined };

      await expect(
        firstValueFrom(interceptor.intercept(context(req), handler({ ok: true }))),
      ).resolves.toEqual({ ok: true });
    });

    it('bounds recursion rather than blowing the stack on a cyclic-looking body', () => {
      let deep: Record<string, unknown> = { cvv: '123' };
      for (let i = 0; i < 40; i += 1) {
        deep = { nested: deep };
      }

      expect(() => interceptor.scrub(deep)).not.toThrow();
    });

    describe('route exemptions', () => {
      class LoginController {
        @AcceptsSecretFields('password')
        login(): void {}
      }

      @ReturnsSecretFields('client_secret')
      class IntentsController {
        create(): void {}
      }

      it('hands a route its own accepted credential, and still scrubs everything else', async () => {
        // Regression: login received '[REDACTED]' as the password and no user could sign in.
        const req = {
          method: 'POST',
          originalUrl: '/v1/auth/login',
          body: { email: 'a@b.example', password: 'hunter2-hunter2', cvv: '123' },
        };

        await firstValueFrom(interceptor.intercept(context(req, LoginController, 'login'), handler({})));

        expect(req.body).toEqual({ email: 'a@b.example', password: 'hunter2-hunter2', cvv: REDACTED });
      });

      it('returns a route-issued credential at any depth, and nothing else denied', async () => {
        // Regression: every PaymentIntent and checkout session came back with client_secret
        // '[REDACTED]', so no browser could tokenise or confirm.
        const req = { method: 'POST', originalUrl: '/v1/payment_intents', body: undefined };

        const result = await firstValueFrom(
          interceptor.intercept(
            context(req, IntentsController, 'create'),
            handler({ client_secret: 'pi_1_secret_x', payment: { client_secret: 'pi_2_secret_y' }, iban: 'GB33' }),
          ),
        );

        expect(result).toEqual({
          client_secret: 'pi_1_secret_x',
          payment: { client_secret: 'pi_2_secret_y' },
          iban: REDACTED,
        });
      });

      it('exempts a returned field on the way out only', async () => {
        const req = { method: 'POST', originalUrl: '/v1/payment_intents', body: { client_secret: 'pi_1_secret_x' } };

        await firstValueFrom(interceptor.intercept(context(req, IntentsController, 'create'), handler({})));

        expect((req.body as Record<string, unknown>).client_secret).toBe(REDACTED);
      });

      it('still masks a PAN inside an exempted field', () => {
        const scrubbed = interceptor.scrub({ password: '4242424242424242' }, new Set(['password'])) as Record<
          string,
          unknown
        >;

        expect(scrubbed.password).toBe(REDACTED_PAN);
      });

      it('exempts nothing on an undecorated route', async () => {
        const req = { method: 'GET', originalUrl: '/v1/x', body: undefined };

        const result = await firstValueFrom(interceptor.intercept(context(req), handler({ client_secret: 'x' })));

        expect(result).toEqual({ client_secret: REDACTED });
      });
    });

    it('passes straight through when the flag is off', async () => {
      const off = new RedactionInterceptor(config(false), new Reflector());
      const req = { method: 'POST', originalUrl: '/v1/x', body: { cvv: '123' } };

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
