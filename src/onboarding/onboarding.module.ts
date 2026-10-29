/**
 * OnboardingModule — self-signup and KYC onboarding (RFC platform-v2 §3).
 *
 * Imports MerchantsModule (the merchant aggregate it creates and activates, the bank accounts
 * a requirement reads) and StaffModule (decisions write `staff_audit_log` in their own
 * transaction). AuthService and EmailService arrive through their global modules. Exports
 * OnboardingService for the admin back office, which is where the decisions are made.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/common.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { StaffModule } from '../staff/staff.module';

import { KycDocumentEntity } from './kyc-document.entity';
import { KycStorageClient } from './kyc-storage-http.client';
import { OnboardingController } from './onboarding.controller';
import { OnboardingEntity } from './onboarding.entity';
import { OnboardingRepository } from './onboarding.repository';
import { OnboardingService } from './onboarding.service';
import { SignupController } from './signup.controller';
import { SignupService } from './signup.service';
import { OnboardingStateMachine } from './state/onboarding.state-machine';

@Module({
  imports: [
    CommonModule,
    MerchantsModule,
    StaffModule,
    TypeOrmModule.forFeature([OnboardingEntity, KycDocumentEntity]),
  ],
  controllers: [SignupController, OnboardingController],
  providers: [
    OnboardingRepository,
    OnboardingStateMachine,
    KycStorageClient,
    OnboardingService,
    SignupService,
  ],
  exports: [OnboardingService],
})
export class OnboardingModule {}
