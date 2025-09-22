/**
 * AuditModule.
 *
 * Imports StaffModule because the sink has to be able to write both trails: which table a
 * `@AuditLog(action)` handler lands in is decided by the principal, not by the route, and
 * binding two separate sinks would mean the interceptor has to know that. It does not.
 *
 * `AUDIT_SINK` is bound here and only here.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/common.module';
import { AUDIT_SINK } from '../common/interceptors/audit-log.interceptor';
import { StaffModule } from '../staff/staff.module';

import { AuditLog } from './audit-log.entity';
import { AuditLogRepository } from './audit-log.repository';
import { AuditService } from './audit.service';

@Module({
  imports: [CommonModule, StaffModule, TypeOrmModule.forFeature([AuditLog])],
  providers: [
    AuditLogRepository,
    AuditService,
    { provide: AUDIT_SINK, useExisting: AuditService },
  ],
  exports: [AuditService, AUDIT_SINK, AuditLogRepository],
})
export class AuditModule {}
