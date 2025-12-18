/**
 * StaffModule — the platform-operator identity.
 *
 * Imports CommonModule and nothing else. It is deliberately at the bottom of the feature
 * graph: AuthModule needs it to resolve a `staff_session` principal and AuditModule needs it
 * to write the staff trail, so anything it imported back would close a cycle through both.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/common.module';

import { StaffAuditService } from './staff-audit.service';
import { StaffAuditLog, StaffUser } from './staff-user.entity';
import { StaffUsersService } from './staff-users.service';

@Module({
  imports: [CommonModule, TypeOrmModule.forFeature([StaffUser, StaffAuditLog])],
  providers: [StaffUsersService, StaffAuditService],
  exports: [StaffUsersService, StaffAuditService, TypeOrmModule],
})
export class StaffModule {}
