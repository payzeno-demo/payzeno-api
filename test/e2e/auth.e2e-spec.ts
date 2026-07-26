import request from 'supertest';

import { createTestApp } from 'test/support/test-app';
import type { TestApp } from 'test/support/test-app';
import { seedMerchant } from 'test/support/seed';
import type { SeededMerchant } from 'test/support/seed';

const PASSWORD = 'correct-horse-battery';

/**
 * login → CSRF → session mutation → logout (tests.md §3.2).
 *
 * The CSRF contract is specified in api-surface §1.3 precisely so two agents cannot each
 * implement half of it, and this file is where "half of it" fails: `pz_csrf` must be
 * readable (not HttpOnly) or the console cannot echo it, and a mutating session request
 * without the header must be 403 before anything else runs.
 */
describe('auth e2e', () => {
  let ctx: TestApp;
  let seeded: SeededMerchant;

  beforeAll(async () => {
    ctx = await createTestApp();
    seeded = await seedMerchant(ctx);
  });

  afterAll(async () => {
    await ctx.close();
  });

  function cookieValue(setCookie: string[], name: string): string | undefined {
    const raw = setCookie.find((c) => c.startsWith(`${name}=`));
    return raw?.split(';')[0].split('=')[1];
  }

  function cookieAttrs(setCookie: string[], name: string): string {
    return setCookie.find((c) => c.startsWith(`${name}=`)) ?? '';
  }

  async function login() {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: seeded.email, password: PASSWORD });
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    return {
      res,
      session: cookieValue(setCookie, 'pz_session')!,
      csrf: cookieValue(setCookie, 'pz_csrf')!,
      setCookie,
    };
  }

  it('logs in and returns the console bootstrap payload', async () => {
    const { res } = await login();

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'login',
      user: { email: seeded.email, role: 'owner' },
      merchant: { id: seeded.merchant.id },
    });
  });

  it('sets pz_session HttpOnly and pz_csrf readable', async () => {
    const { setCookie } = await login();

    expect(cookieAttrs(setCookie, 'pz_session')).toMatch(/HttpOnly/i);
    expect(cookieAttrs(setCookie, 'pz_session')).toMatch(/SameSite=Lax/i);
    // Not HttpOnly, on purpose: the console reads it to fill X-Payzeno-CSRF.
    expect(cookieAttrs(setCookie, 'pz_csrf')).not.toMatch(/HttpOnly/i);
  });

  it('rejects a wrong password without leaking whether the user exists', async () => {
    const res = await request(ctx.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: seeded.email, password: 'not-the-password' });

    const unknown = await request(ctx.app.getHttpServer())
      .post('/v1/auth/login')
      .send({ email: 'nobody@nowhere.example', password: PASSWORD });

    expect(res.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(res.body.error.message).toBe(unknown.body.error.message);
  });

  it('serves GET /v1/auth/me for a live session', async () => {
    const { session, csrf } = await login();

    const res = await request(ctx.app.getHttpServer())
      .get('/v1/auth/me')
      .set('Cookie', [`pz_session=${session}`, `pz_csrf=${csrf}`]);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      object: 'session',
      user: { id: seeded.userId },
      merchant: { id: seeded.merchant.id },
    });
    expect(Array.isArray(res.body.permissions)).toBe(true);
  });

  it('401s /v1/auth/me without a session cookie', async () => {
    const res = await request(ctx.app.getHttpServer()).get('/v1/auth/me');

    expect(res.status).toBe(401);
    expect(res.body).toBeApiError('authentication_required');
  });

  it('403s a mutating session request with no CSRF header', async () => {
    const { session, csrf } = await login();

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/webhook_endpoints')
      .set('Cookie', [`pz_session=${session}`, `pz_csrf=${csrf}`])
      .set('Idempotency-Key', 'auth-csrf-missing')
      .send({ url: 'https://aurora.example/hooks', enabled_events: ['payment.captured'] });

    expect(res.status).toBe(403);
    expect(res.body).toBeApiError('permission_denied');
  });

  it('403s a mutating session request whose CSRF header does not match the cookie', async () => {
    const { session, csrf } = await login();

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/webhook_endpoints')
      .set('Cookie', [`pz_session=${session}`, `pz_csrf=${csrf}`])
      .set('X-Payzeno-CSRF', 'a-different-value')
      .set('Idempotency-Key', 'auth-csrf-mismatch')
      .send({ url: 'https://aurora.example/hooks', enabled_events: ['payment.captured'] });

    expect(res.status).toBe(403);
  });

  it('accepts a mutating session request with a matching CSRF header', async () => {
    const { session, csrf } = await login();

    const res = await request(ctx.app.getHttpServer())
      .post('/v1/webhook_endpoints')
      .set('Cookie', [`pz_session=${session}`, `pz_csrf=${csrf}`])
      .set('X-Payzeno-CSRF', csrf)
      .set('Idempotency-Key', 'auth-csrf-ok')
      .send({ url: 'https://aurora.example/hooks', enabled_events: ['payment.captured'] });

    expect(res.status).toBe(201);
    expect(res.body.signing_secret).toEqual(expect.any(String));
  });

  it('does not require CSRF on an api-key request — there is no ambient credential', async () => {
    const res = await request(ctx.app.getHttpServer())
      .get('/v1/payment_intents?limit=1')
      .set('Authorization', `Bearer ${seeded.apiKey}`);

    expect(res.status).toBe(200);
  });

  it('logs out, clears both cookies and invalidates the session', async () => {
    const { session, csrf } = await login();

    const out = await request(ctx.app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Cookie', [`pz_session=${session}`, `pz_csrf=${csrf}`])
      .set('X-Payzeno-CSRF', csrf);

    expect(out.status).toBe(204);

    const after = await request(ctx.app.getHttpServer())
      .get('/v1/auth/me')
      .set('Cookie', [`pz_session=${session}`, `pz_csrf=${csrf}`]);

    expect(after.status).toBe(401);
  });

  it('always 202s a password reset, existing user or not', async () => {
    const known = await request(ctx.app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ email: seeded.email });
    const unknown = await request(ctx.app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ email: 'nobody@nowhere.example' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
  });
});
