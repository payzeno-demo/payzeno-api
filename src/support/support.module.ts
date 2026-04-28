/**
 * SupportModule — one entity, one service, no controller.
 *
 * There is no public route into `support_task` and there should not be: a merchant seeing
 * "possible double charge on ch_…" before a human has looked at the acquirer's portal is a
 * support ticket we did not need. The rows are written by `LedgerEventsConsumer` and by
 * `InternalController#createSupportTask`, and read by the staff console through
 * `StaffModule`.
 *
 * Imports CommonModule only — it is a leaf, and `EventsModule` deliberately does not import it
 * (the consumer resolves `SupportTasksService` through `ModuleRef` in `onModuleInit`; see
 * docs/adr/0009-event-consumer-wiring.md).
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/common.module';

import { SupportTaskEntity } from './support-task.entity';
import { SupportTasksService } from './support-tasks.service';

@Module({
  imports: [CommonModule, TypeOrmModule.forFeature([SupportTaskEntity])],
  providers: [SupportTasksService],
  exports: [SupportTasksService, TypeOrmModule],
})
