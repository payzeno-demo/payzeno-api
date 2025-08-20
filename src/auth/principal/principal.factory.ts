/**
 * PrincipalFactory — the one place an `AuthPrincipal` is constructed.
 *
 * Five variants (types.ts §Auth context), five builders, and no other file in the repo is
 * allowed to write an object literal with a `kind` field. The reason is `staff_session`: it
 * has no `merchant_id`, only `acting_merchant_id`, and every ad-hoc construction of a
 * principal somewhere else in the codebase was an ad-hoc construction that got that wrong and
 * let a Payzeno operator's request resolve as the merchant's own admin.
 *
 * The free functions below (`merchantIdOf`, `livemodeOf`, `staffIdOf`) are what controllers
 * and interceptors use. They are here rather than on the class because a controller taking a
 * `PrincipalFactory` dependency to read a field off a value it already has is noise.
 */
import { Injectable } from '@nestjs/common';

import type {
  ApiKeyMode,
  ApiKeyScope,
  AuthPrincipal,
  MerchantId,
  PaymentIntentId,
  StaffRole,
  UserId,
  UserRole,
} from '@payzeno/contracts';

import { PermissionDeniedException } from '../../common/errors/auth.exceptions';
import type { ApiKeyEntity } from '../../merchants/api-keys/api-key.entity';
import type { MerchantUserEntity } from '../../merchants/users/merchant-user.entity';

export type InternalCallerService = 'payzeno-ledger' | 'payzeno-billing-legacy';

@Injectable()
export function merchantIdOf(principal: AuthPrincipal): MerchantId {
  switch (principal.kind) {
    case 'api_key':
    case 'dashboard_session':
    case 'client_secret':
      return principal.merchant_id;
    case 'staff_session':
      if (!principal.acting_merchant_id) {
        throw new PermissionDeniedException(
          'merchant_id is required on staff requests to a merchant-scoped route',
          { staff_id: principal.staff_id },
        );
      }
      return principal.acting_merchant_id;
    case 'internal_service':
      throw new PermissionDeniedException('Internal services must use the /internal/v1 surface', {
        service: principal.service,
      });
  }
}

export function livemodeOf(principal: AuthPrincipal): boolean {
  switch (principal.kind) {
    case 'api_key':
      return principal.mode === 'live';
    case 'dashboard_session':
    case 'staff_session':
    case 'client_secret':
      return true;
    case 'internal_service':
      return true;
  }
}

