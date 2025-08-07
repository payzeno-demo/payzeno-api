/**
 * 401/403. Thrown by the guards in src/auth/guards and by CsrfService.
 *
 * Note there is no "merchant not yours" exception: MerchantScopeGuard raises
 * ResourceNotFoundException, never PermissionDeniedException. Confirming that a resource
 * exists but belongs to somebody else leaks tenant membership. api-surface.md §1.2.
 */
import type { ErrorCode } from '@payzeno/contracts';

import { ApiException } from './api.exception';

/** No credential presented at all. */
export class AuthenticationRequiredException extends ApiException {
  readonly code: ErrorCode = 'authentication_required';
  readonly httpStatus = 401;

  constructor(message = 'Authentication required', details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * A credential was presented and did not resolve. Thrown by `ApiKeyResolver.resolve` for an
 * unknown lookup hash, a failed argon2 verify, and a revoked key — deliberately the same
 * class and the same message for all three, so the response cannot be used as an oracle.
 */
export class InvalidApiKeyException extends ApiException {
  readonly code: ErrorCode = 'invalid_api_key';
  readonly httpStatus = 401;

  constructor(message = 'Invalid API key', details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** 403. RolesGuard, StaffGuard, CsrfService.assert, and the staff-only field check on PATCH. */
export class PermissionDeniedException extends ApiException {
  readonly code: ErrorCode = 'permission_denied';
  readonly httpStatus = 403;

  constructor(message = 'Permission denied', details?: Record<string, unknown>) {
    super(message, details);
  }

  static missingScope(scope: string): PermissionDeniedException {
    return new PermissionDeniedException(`API key is missing the required scope '${scope}'`, {
      required_scope: scope,
    });
  }

  static staffRoleRequired(roles: readonly string[]): PermissionDeniedException {
    return new PermissionDeniedException('Staff role required', {
      required_roles: roles.join(','),
    });
  }
}
