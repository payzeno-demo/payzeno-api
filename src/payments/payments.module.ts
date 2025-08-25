/**
 * PaymentsModule — the money path's wiring.
 *
 * Blueprint §2's edge list: CommonModule, ApiModule, MerchantsModule, LedgerModule,
 * EventsModule, AuditModule. Plus two `forwardRef`s, and those need explaining.
 *
 * `ProcessorWebhookService` (here) needs `DisputesService` and `RefundsService`; both of those
 * modules import PaymentsModule for the charge repository and the processor router. That is a
 * genuine cycle in the domain — an acquirer webhook is a payments event that resolves into a
 * dispute or a refund — and the alternatives are worse: a fourth module that owns nothing but
 * the switch statement, or `ModuleRef.get(..., { strict: false })`, which is what
 * `EventsModule` does and which we keep to consumers because there the wiring is genuinely
 * dynamic. Two `forwardRef`s, documented, are the cheapest honest answer.
 * docs/adr/0001-nestjs-module-boundaries.md, and docs/adr/0009 for the consumer variant.
 */

import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiModule } from '../api/api.module';
import { DEFAULT_CLIENT_OPTIONS } from '../api/client';
import { CircuitBreakerRegistry } from '../api/circuit-breaker';
import { IdempotentRetryPolicy, NoRetryPolicy } from '../api/retry.policy';
import { HTTP_TRANSPORT, type HttpTransport } from '../api/transport.interface';
import { AuditModule } from '../audit/audit.module';
import { CommonModule } from '../common/common.module';
import { CLOCK, type Clock } from '../common/time/clock';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { ApiConfig } from '../config/api-config.type';
import { DisputesModule } from '../disputes/disputes.module';
import { EventsModule } from '../events/events.module';
import { LedgerModule } from '../ledger/ledger.module';
import { MerchantsModule } from '../merchants/merchants.module';
import { RefundsModule } from '../refunds/refunds.module';
import { ChargeAuthorizationService } from './charge-authorization.service';
import { ChargeCaptureService } from './charge-capture.service';
import { ChargeExpiryPolicy } from './charge-expiry.policy';
