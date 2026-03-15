/**
 * DisputesModule — CommonModule, PaymentsModule, LedgerModule, EventsModule (blueprint §2).
 *
 * `DisputesService` is exported because two things outside this module create or close
 * disputes: `ProcessorWebhookService` (the acquirer's `dispute_opened` / `dispute_closed`
 * webhooks) and `DisputeDeadlineReminderJob`. Both go through the service so that
 * `dispute.closed` keeps exactly one emitter.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/common.module';
import { EventsModule } from '../events/events.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentsModule } from '../payments/payments.module';
import { DisputeEntity, DisputeFeeScheduleEntity } from './dispute.entity';
import { DisputeEvidenceService } from './dispute-evidence.service';
import { DisputeFeeService } from './dispute-fee.service';
import { DisputeRepository } from './dispute.repository';
import { DisputesController } from './disputes.controller';
import { DisputesService } from './disputes.service';
import { DisputeStateMachine } from './state/dispute.state-machine';

@Module({
  imports: [
    CommonModule,
    PaymentsModule,
    LedgerModule,
    EventsModule,
    TypeOrmModule.forFeature([DisputeEntity, DisputeFeeScheduleEntity]),
  ],
  controllers: [DisputesController],
  providers: [
    DisputesService,
    DisputeRepository,
    DisputeFeeService,
    DisputeEvidenceService,
    DisputeStateMachine,
  ],
  exports: [DisputesService, DisputeRepository, DisputeFeeService],
})
export class DisputesModule {}
