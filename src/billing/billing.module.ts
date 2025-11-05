/**
 * BillingModule — CommonModule, ApiModule, LedgerModule (the MIG swap target), EventsModule.
 *
 * `BillingLegacyClient` is built by a factory, like `LedgerHttpClient`, because it needs its
 * own timeout block and its own circuit breaker instance. The breaker settings are the ones
 * api-surface.md §13 contracts: 50% error threshold over 20 requests, 30s reset. A trip is a
 * `502 legacy_upstream_unavailable`, not a 500 — the legacy service being down is a known
 * operating state, not a defect in this repo.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApiModule } from '../api/api.module';
import { DEFAULT_CLIENT_OPTIONS } from '../api/client';
import { CircuitBreakerRegistry } from '../api/circuit-breaker';
import { NoRetryPolicy } from '../api/retry.policy';
import { HTTP_TRANSPORT, type HttpTransport } from '../api/transport.interface';
import { CommonModule } from '../common/common.module';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { ApiConfig } from '../config/api-config.type';
import { EventsModule } from '../events/events.module';
import { LedgerModule } from '../ledger/ledger.module';
import { BillingLegacyClient } from './billing-legacy.client';
import { InvoiceSourceResolver } from './invoice-source.resolver';
import { InvoicesController } from './invoices.controller';
