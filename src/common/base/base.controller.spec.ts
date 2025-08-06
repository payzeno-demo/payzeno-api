import type { ApiKeyScope, AuthPrincipal, MerchantId } from '@payzeno/contracts';

import { BaseController } from 'src/common/base/base.controller';
import type { MerchantScope } from 'src/common/base/merchant-scoped.entity';
import { AuthenticationRequiredException, PermissionDeniedException } from 'src/common/errors/auth.exceptions';

import {
  makeApiKeyPrincipal,
  makeClientSecretPrincipal,
  makeInternalPrincipal,
  makeScopedApiKeyPrincipal,
  makeSessionPrincipal,
  makeStaffPrincipalWithRole,
} from 'test/factories/principal.factory';
import { TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * `BaseController` is the scope resolution every merchant-facing controller inherits, and the
 * two things it refuses are the interesting part:
 *
 *   - a `staff_session` with no `acting_merchant_id`. api-surface.md §1.2 makes `?merchant_id=`
 *     required on every staff-marked scoped read, and without it a staff list request would
 *     silently be a platform-wide list request.
 *   - an `internal_service` principal on a `/v1/` route. That is a routing bug, not a
 *     permission, and it means nginx let something through it should have denied.
 *
 * There are no handlers on the base on purpose: Nest resolves routes off the concrete class's
 * decorators, and an inherited `@Get()` becomes a route on every subclass. That is how
 * `/v1/refunds` once answered on `/v1/disputes`.
 */
class TestController extends BaseController {
  scope(principal: AuthPrincipal): MerchantScope {
    return this.scopeOf(principal);
  }

  merchant(principal: AuthPrincipal): MerchantId {
    return this.merchantIdOf(principal);
  }

  require(principal: AuthPrincipal | undefined | null): AuthPrincipal {
    return this.requirePrincipal(principal);
  }

  scopeCheck(principal: AuthPrincipal, scope: ApiKeyScope): void {
    this.assertScope(principal, scope);
  }

  staff(principal: AuthPrincipal): boolean {
    return this.isStaff(principal);
  }
}

describe('BaseController', () => {
  const controller = new TestController();

  describe('scopeOf', () => {
    it('reads merchant and livemode off a live api key', () => {
      expect(controller.scope(makeApiKeyPrincipal({ mode: 'live' }))).toEqual({
        merchantId: TEST_MERCHANT_ID,
        livemode: true,
      });
    });

    it('reports livemode false for a test-mode key', () => {
      expect(controller.scope(makeApiKeyPrincipal({ mode: 'test' })).livemode).toBe(false);
    });

    it('treats a dashboard session as livemode', () => {
      // The console switches mode by presenting a `sk_test_` key, not by flipping a session
      // field — so a session is always live.
      expect(controller.scope(makeSessionPrincipal())).toEqual({
        merchantId: TEST_MERCHANT_ID,
        livemode: true,
      });
    });

    it('scopes a client secret to its intent merchant', () => {
      expect(controller.scope(makeClientSecretPrincipal()).merchantId).toBe(TEST_MERCHANT_ID);
    });

    it('uses acting_merchant_id for a staff session', () => {
      expect(controller.scope(makeStaffPrincipalWithRole('risk', TEST_MERCHANT_ID)).merchantId).toBe(
        TEST_MERCHANT_ID,
      );
    });

    it('refuses a staff session that named no merchant', () => {
      expect(() => controller.scope(makeStaffPrincipalWithRole('risk', null))).toThrow(
        PermissionDeniedException,
      );
    });

    it('refuses an internal service on the public surface', () => {
      const err = (() => {
        try {
          controller.scope(makeInternalPrincipal());
          return null;
        } catch (e) {
          return e as PermissionDeniedException;
        }
      })();

      expect(err).toBeInstanceOf(PermissionDeniedException);
      expect(err?.message).toContain('/internal/v1');
    });
  });

  describe('merchantIdOf', () => {
    it('is the merchant id of the resolved scope', () => {
      expect(controller.merchant(makeApiKeyPrincipal())).toBe(TEST_MERCHANT_ID);
    });

    it('throws for the same principals scopeOf refuses', () => {
      expect(() => controller.merchant(makeStaffPrincipalWithRole('finance', null))).toThrow(
        PermissionDeniedException,
      );
    });
  });

  describe('requirePrincipal', () => {
    it('passes a principal through', () => {
      const principal = makeSessionPrincipal();

      expect(controller.require(principal)).toBe(principal);
    });

    it.each([[undefined], [null]])('throws 401 for %p', (value) => {
      expect(() => controller.require(value)).toThrow(AuthenticationRequiredException);
    });
  });

  describe('assertScope', () => {
    it('passes when the key carries the scope', () => {
      const principal = makeScopedApiKeyPrincipal(['payouts:read', 'payouts:write']);

      expect(() => controller.scopeCheck(principal, 'payouts:write')).not.toThrow();
    });

    it('refuses when the key does not', () => {
      const principal = makeScopedApiKeyPrincipal(['payouts:read']);

      expect(() => controller.scopeCheck(principal, 'payouts:write')).toThrow(
        PermissionDeniedException,
      );
    });

    it('does not apply to a session — roles decide there, not scopes', () => {
      expect(() => controller.scopeCheck(makeSessionPrincipal(), 'payouts:write')).not.toThrow();
    });

    it('does not apply to a staff session', () => {
      expect(() =>
        controller.scopeCheck(makeStaffPrincipalWithRole('finance', TEST_MERCHANT_ID), 'payouts:write'),
      ).not.toThrow();
    });

    it('is exact — it does not expand implied scopes', () => {
      // The expansion belongs to ApiKeyGuard via `coversRequired`. This is the belt to that
      // guard's braces for handlers whose required scope depends on the body, and a belt that
      // re-implements the expansion is a second place for the two to drift apart.
      const principal = makeScopedApiKeyPrincipal(['payment_intents:write']);

      expect(() => controller.scopeCheck(principal, 'charges:read')).toThrow(
        PermissionDeniedException,
      );
    });
  });

  describe('isStaff', () => {
    it('is true only for a staff session', () => {
      expect(controller.staff(makeStaffPrincipalWithRole('support', null))).toBe(true);
      expect(controller.staff(makeSessionPrincipal())).toBe(false);
      expect(controller.staff(makeApiKeyPrincipal())).toBe(false);
      expect(controller.staff(makeInternalPrincipal())).toBe(false);
    });
  });

  it('declares no route handlers of its own', () => {
    // An inherited `@Get()` would register on every subclass. There must be nothing here for
    // Nest's route explorer to find.
    const inherited = Object.getOwnPropertyNames(BaseController.prototype).filter(
      (name) => name !== 'constructor',
    );

    for (const name of inherited) {
      expect(Reflect.getMetadata('path', BaseController.prototype, name)).toBeUndefined();
    }
  });
});
