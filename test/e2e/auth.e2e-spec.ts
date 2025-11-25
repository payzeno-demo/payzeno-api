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
    const { setCookie } = await login();

    expect(cookieAttrs(setCookie, 'pz_session')).toMatch(/HttpOnly/i);
    expect(cookieAttrs(setCookie, 'pz_session')).toMatch(/SameSite=Lax/i);
    // Not HttpOnly, on purpose: the console reads it to fill X-Payzeno-CSRF.
    expect(cookieAttrs(setCookie, 'pz_csrf')).not.toMatch(/HttpOnly/i);
  });

  it('rejects a wrong password without leaking whether the user exists', async () => {
    const { session, csrf } = await login();

    const out = await request(ctx.app.getHttpServer())
      .post('/v1/auth/logout')
      .set('Cookie', [`pz_session=${session}`, `pz_csrf=${csrf}`])
      .set('X-Payzeno-CSRF', csrf);

    expect(out.status).toBe(204);

    const unknown = await request(ctx.app.getHttpServer())
      .post('/v1/auth/password/reset')
      .send({ email: 'nobody@nowhere.example' });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
  });
});
