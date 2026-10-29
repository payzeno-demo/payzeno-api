import { scrubDeep, scrubForAudit } from './scrub';

const SESSION = 'cs_01JB3Z8Q4M7N2P5R6T9V0W1X2Y';
const SECRET = `${SESSION}_secret_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4`;
const URL_WITH_SECRET = `http://pay.localhost/c/${SESSION}#${SECRET}`;

describe('scrubForAudit', () => {
  it('masks a client secret embedded in a hosted checkout url', () => {
    const out = scrubForAudit({ id: SESSION, url: URL_WITH_SECRET }) as { url: string };
    expect(out.url).toBe(`http://pay.localhost/c/${SESSION}#${SESSION}_secret_[REDACTED]`);
    expect(out.url).not.toContain('a1b2c3d4');
  });

  it('still applies the PAN scan', () => {
    const out = scrubForAudit({ note: 'card 4242424242424242' }) as { note: string };
    expect(out.note).not.toContain('4242424242424242');
  });
});

describe('scrubDeep', () => {
  it('leaves the hosted url intact for the response the merchant receives', () => {
    const out = scrubDeep({ url: URL_WITH_SECRET }) as { url: string };
    expect(out.url).toBe(URL_WITH_SECRET);
  });
});
