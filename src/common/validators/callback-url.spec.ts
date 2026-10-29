import { ValidationException } from 'src/common/errors/api.exception';
import { allowsPlainHttp, assertCallbackUrl } from 'src/common/validators/callback-url';

/**
 * Where Payzeno sends a browser or a webhook. Production is https-only; every other environment
 * also takes http, because the local demo shops are plain-http hosts with no certificate.
 */
describe('assertCallbackUrl', () => {
  function fieldError(run: () => unknown): { path: string; code: string } | undefined {
    try {
      run();
    } catch (err) {
      if (err instanceof ValidationException) return err.fieldErrors[0];
      throw err;
    }
    return undefined;
  }

  it('accepts https everywhere', () => {
    expect(assertCallbackUrl('https://shop.example/thanks', 'success_url', 'production').hostname).toBe('shop.example');
  });

  it('accepts http outside production', () => {
    // Regression: http was refused everywhere, so no local shop could set a return_url or webhook.
    expect(() => assertCallbackUrl('http://northwind.shop.localhost:3000/thanks', 'success_url', 'development')).not.toThrow();
    expect(allowsPlainHttp('test')).toBe(true);
  });

  it('refuses http in production', () => {
    expect(fieldError(() => assertCallbackUrl('http://shop.example/thanks', 'return_url', 'production'))).toEqual(
      expect.objectContaining({ path: 'return_url', code: 'invalid_scheme' }),
    );
  });

  it('refuses a scheme that is neither', () => {
    expect(fieldError(() => assertCallbackUrl('javascript:alert(1)', 'return_url', 'development'))).toEqual(
      expect.objectContaining({ code: 'invalid_scheme' }),
    );
  });

  it('refuses something that is not an absolute URL', () => {
    expect(fieldError(() => assertCallbackUrl('/thanks', 'success_url', 'development'))).toEqual(
      expect.objectContaining({ path: 'success_url', code: 'invalid_format' }),
    );
  });

  describe('originOnly', () => {
    it('accepts an origin, with or without the trailing slash', () => {
      expect(() =>
        assertCallbackUrl('https://shop.example:8443', 'allowed_origin', 'production', { originOnly: true }),
      ).not.toThrow();
      expect(() =>
        assertCallbackUrl('https://shop.example/', 'allowed_origin', 'production', { originOnly: true }),
      ).not.toThrow();
    });

    it('refuses a path', () => {
      expect(
        fieldError(() => assertCallbackUrl('https://shop.example/pay', 'allowed_origin', 'production', { originOnly: true })),
      ).toEqual(expect.objectContaining({ path: 'allowed_origin', code: 'invalid_format' }));
    });
  });
});
