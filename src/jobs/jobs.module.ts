/**
 * JobsModule — the background surface.
 *
 * One line per job, nine jobs, twelve months. Every job is registered here and nowhere else,
 * and `ScheduleModule.forRoot()` is imported exactly once in the application — if it is
 * imported twice, Nest registers every cron twice in the same task and the Redis lease is the
 * only thing standing between you and double execution.
 *
 * Import list mirrors what the jobs actually reach into: EventsModule (outbox drain),
 * WebhooksModule (delivery), MerchantsModule (risk), PaymentsModule (sweep + expiry),
 * DisputesModule (deadlines), LedgerModule (both the sweep's `listTransactions` and the
 * expiry's `auth_release` posting).
 *
 * docs/runbooks/payzeno-api.md lists every job, its lease and what to do when it stops.
 * — apager
 */
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CommonModule } from '../common/common.module';
import { IdempotencyRecord } from '../common/idempotency/idempotency-record.entity';
import { DisputesModule } from '../disputes/disputes.module';
import { EventsModule } from '../events/events.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { PaymentsModule } from '../payments/payments.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

import { ChargeExpiryJob } from './charge-expiry.job';
import { DisputeDeadlineReminderJob } from './dispute-deadline-reminder.job';
