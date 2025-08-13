/**
 * AuditLogInterceptor — writes one row for every handler carrying `@AuditLog(action)`.
 * 22 application sites.
 *
 * Which table is decided by the PRINCIPAL, not by the route:
 *   merchant principal (api_key / dashboard_session) → `audit_log`
 *   staff_session                                    → `staff_audit_log`
 * A staff user editing a merchant must land in the staff trail regardless of which route they
 * used, or the "who suspended this merchant" question has two possible answers.
 *
 * The sink is a port rather than a direct AuditService dependency: interceptors sit in the
 * http-plumbing layer and eslint-plugin-boundaries does not let them import a service.
 * `AuditModule` binds the real implementation; the fallback here only exists so a module that
 * forgets to import AuditModule fails loudly in the log instead of silently dropping the trail.
 */
import {
  Inject,
  Injectable,
  Optional,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { tap, type Observable } from 'rxjs';

import type { AuditActorType, AuthPrincipal } from '@payzeno/contracts';

import { AUDIT_LOG_KEY, type AuditLogSpec } from '../decorators/audit-log.decorator';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../logging/logger';
import { getRequestContext } from '../logging/request-context';

export interface AuditEntry {
  merchantId: string | null;
  actorType: AuditActorType;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  requestId: string;
  ip: string | null;
  livemode: boolean;
}

export interface StaffAuditEntry extends Omit<AuditEntry, 'merchantId' | 'actorType' | 'livemode'> {
  staffId: string;
  actingMerchantId: string | null;
  reason: string | null;
}

/** Implemented by AuditService (src/audit) and StaffAuditService (src/staff). */
export interface AuditSink {
  record(entry: AuditEntry): Promise<void>;
  recordStaff(entry: StaffAuditEntry): Promise<void>;
}

export const AUDIT_SINK = Symbol('AUDIT_SINK');

interface HttpRequest {
  ip?: string;
  params: Record<string, string>;
  body?: unknown;
  principal?: AuthPrincipal;
}

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
    @Optional() @Inject(AUDIT_SINK) private readonly sink?: AuditSink,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const spec = this.reflector.getAllAndOverride<AuditLogSpec | undefined>(AUDIT_LOG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!spec) return next.handle();

    const req = context.switchToHttp().getRequest<HttpRequest>();
    const principal = req.principal;

    return next.handle().pipe(
      tap({
        // Only successful handlers are audited. A 422 is in the access log, not the audit trail.
        next: (body) => {
          void this.write(spec, principal, req, body);
        },
      }),
    );
  }

  private async write(
    spec: AuditLogSpec,
    principal: AuthPrincipal | undefined,
    req: HttpRequest,
    body: unknown,
  ): Promise<void> {
    if (!principal) return;

    if (!this.sink) {
      this.logger.error('AUDIT_SINK is unbound — audit trail dropped', undefined, {
        action: spec.action,
      });
      return;
    }

    const ctx = getRequestContext();
    const resourceId = this.resolveResourceId(spec, req, body);
    const common = {
      action: spec.action,
      resourceType: spec.resourceType ?? spec.action.split('.')[0],
      resourceId,
      before: null,
      after: body ?? null,
      requestId: ctx?.requestId ?? 'unknown',
      ip: req.ip ?? null,
    };

    try {
      if (principal.kind === 'staff_session') {
        await this.sink.recordStaff({
          ...common,
          staffId: principal.staff_id,
          actingMerchantId: principal.acting_merchant_id,
          reason: readReason(req.body),
        });
        return;
      }

      await this.sink.record({
        ...common,
        merchantId: ctx?.merchantId ?? null,
        actorType: actorTypeOf(principal),
        actorId: actorIdOf(principal),
        livemode: ctx?.livemode ?? false,
      });
    } catch (err) {
      // Never fail the request on an audit write. The row is reconstructable from the access
      // log; a 500 after a successful capture is not.
      this.logger.error('audit write failed', err, { action: spec.action });
    }
  }

  private resolveResourceId(spec: AuditLogSpec, req: HttpRequest, body: unknown): string | null {
    if (spec.idParam && req.params[spec.idParam]) return req.params[spec.idParam];
    if (body && typeof body === 'object' && 'id' in body) {
      const id = (body as { id?: unknown }).id;
      if (typeof id === 'string') return id;
    }
    return null;
  }
}

function actorTypeOf(principal: AuthPrincipal): AuditActorType {
  switch (principal.kind) {
    case 'api_key':
      return 'api_key';
    case 'dashboard_session':
      return 'user';
    case 'staff_session':
      return 'staff';
    case 'internal_service':
      return 'internal_service';
    case 'client_secret':
      return 'system';
  }
}

function actorIdOf(principal: AuthPrincipal): string | null {
  switch (principal.kind) {
    case 'api_key':
      return principal.api_key_id;
    case 'dashboard_session':
      return principal.user_id;
    case 'staff_session':
      return principal.staff_id;
    case 'internal_service':
      return principal.service;
    case 'client_secret':
      return principal.payment_intent_id;
  }
}

function readReason(body: unknown): string | null {
  if (body && typeof body === 'object' && 'reason' in body) {
    const reason = (body as { reason?: unknown }).reason;
    if (typeof reason === 'string') return reason;
  }
  return null;
}
