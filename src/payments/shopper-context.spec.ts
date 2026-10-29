import { shopperContextFrom } from 'src/payments/shopper-context';

describe('shopperContextFrom', () => {
  it('reads the edge country and the first forwarded hop', () => {
    expect(
      shopperContextFrom({ 'x-payzeno-geo-country': 'de', 'x-forwarded-for': '85.214.0.9, 10.0.0.2' }, 'development'),
    ).toEqual({ country: 'DE', ip: '85.214.0.9' });
  });

  it('lets the override win outside production', () => {
    const headers = { 'x-payzeno-geo-country': 'US', 'x-payzeno-geo-override': 'JP' };
    expect(shopperContextFrom(headers, 'development').country).toBe('JP');
    expect(shopperContextFrom(headers, 'test').country).toBe('JP');
  });

  it('ignores the override in production', () => {
    const headers = { 'x-payzeno-geo-country': 'US', 'x-payzeno-geo-override': 'JP' };
    expect(shopperContextFrom(headers, 'production').country).toBe('US');
  });

  it('answers null for anything that is not a country code or an address', () => {
    expect(
      shopperContextFrom({ 'x-payzeno-geo-country': 'Germany', 'x-forwarded-for': 'not an ip' }, 'development'),
    ).toEqual({ country: null, ip: null });
  });

  it('never falls back to the socket: behind nginx that is nginx', () => {
    expect(shopperContextFrom({}, 'development')).toEqual({ country: null, ip: null });
  });
});
