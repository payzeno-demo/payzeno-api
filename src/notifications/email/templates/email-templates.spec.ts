import { EMAIL_TEMPLATES } from '@payzeno/contracts';

import { escapeHtml, renderLayout } from 'src/notifications/email/templates/email-layout';
import { renderEmail, renderSubject } from 'src/notifications/email/templates/email-templates';

/**
 * Every template the contract names renders — with its data, and with none at all. The second
 * half is the promise callers rely on: a key nobody sent renders blank, it does not throw, and a
 * message that cannot render is a message that never goes out.
 */
describe('email templates', () => {
  const ctx = { consoleUrl: 'http://console.test' };

  it.each(EMAIL_TEMPLATES.map((t) => [t]))('%s renders with no data at all', (template) => {
    const rendered = renderEmail(template, {}, ctx);

    expect(rendered.subject.length).toBeGreaterThan(0);
    expect(rendered.html).toContain('<!doctype html>');
    expect(rendered.text).toContain('Payzeno');
    expect(rendered.html).not.toContain('undefined');
    expect(rendered.text).not.toContain('undefined');
    expect(rendered.text).not.toContain('null');
  });

  it('puts the verification link in both parts', () => {
    const rendered = renderEmail(
      'signup_verify',
      { merchant_name: 'Acme', verify_url: 'http://console.test/verify-email?token=abc' },
      ctx,
    );

    expect(rendered.subject).toBe('Confirm your email to finish setting up Acme on Payzeno');
    expect(rendered.html).toContain('href="http://console.test/verify-email?token=abc"');
    expect(rendered.text).toContain('Confirm email address: http://console.test/verify-email?token=abc');
  });

  it('escapes merchant- and shopper-controlled text in the HTML part', () => {
    const rendered = renderEmail('receipt', { merchant_name: '<script>alert(1)</script>', amount: '$5.00' }, ctx);

    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('drops detail rows whose value is blank', () => {
    const rendered = renderEmail('receipt', { merchant_name: 'Acme', amount: '$5.00' }, ctx);

    expect(rendered.text).toContain('Amount paid: $5.00');
    expect(rendered.text).not.toContain('Payment method:');
  });

  it('never turns a non-http(s) url into a button', () => {
    const rendered = renderEmail(
      'subscription_payment_failed',
      { merchant_name: 'Acme', update_url: 'javascript:alert(1)' },
      ctx,
    );

    expect(rendered.html).not.toContain('javascript:');
    expect(rendered.text).not.toContain('Update your card:');
  });

  it('falls back to CONSOLE_PUBLIC_URL when the caller sent no console_url', () => {
    const rendered = renderEmail('onboarding_approved', { merchant_name: 'Acme' }, ctx);

    expect(rendered.text).toContain('Go to your dashboard: http://console.test');
  });

  it('renders the staff message on a decision email', () => {
    const rendered = renderEmail(
      'onboarding_info_requested',
      { merchant_name: 'Acme', message: 'Upload a clearer passport scan', console_url: 'http://console.test/onboarding' },
      ctx,
    );

    expect(rendered.subject).toBe('Action needed: more information for Acme');
    expect(rendered.text).toContain('What we need: Upload a clearer passport scan');
  });

  it('renders numbers and booleans as text', () => {
    expect(renderSubject('payout_paid', { amount: 1250 }, ctx)).toBe('Your payout of 1250 has been paid');
  });

  describe('layout', () => {
    it('collapses whitespace in the subject — a header line cannot carry a newline', () => {
      expect(renderLayout({ subject: 'a\n  b', heading: 'h', paragraphs: [] }).subject).toBe('a b');
    });

    it('escapes every HTML-significant character', () => {
      expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    });
  });
});
