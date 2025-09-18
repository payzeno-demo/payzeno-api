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
