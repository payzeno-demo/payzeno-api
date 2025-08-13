/**
 * `@AuditLog('merchant.create')` — every mutating handler carries one. 22 sites.
 *
 * AuditLogInterceptor writes `audit_log` for a merchant principal and `staff_audit_log` for a
 * staff principal. Which table is decided by the principal, not by the decorator — a staff
 * user editing a merchant must land in the staff trail regardless of the route.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const AUDIT_LOG_KEY = 'payzeno:audit_log';

export interface AuditLogSpec {
  /** Dotted action, `<resource>.<verb>`. Indexed; keep the vocabulary small. */
  action: string;
  /** `audit_log.resource_type`. Defaults to the action's first segment. */
  resourceType?: string;
  /** Route param holding the resource id. Defaults to the response body's `id`. */
  idParam?: string;
  /** Capture the before-image. Off by default: it costs a read. */
  captureBefore?: boolean;
}

export const AuditLog = (action: string, spec: Omit<AuditLogSpec, 'action'> = {}): CustomDecorator =>
  SetMetadata(AUDIT_LOG_KEY, {
    action,
    resourceType: spec.resourceType ?? action.split('.')[0],
    idParam: spec.idParam,
    captureBefore: spec.captureBefore ?? false,
  } satisfies AuditLogSpec);
