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
import { ChargeEntity } from './charge.entity';
import { ChargeRepository } from './charge.repository';
import { ChargesController } from './charges.controller';
import { ChargesService } from './charges.service';
import { CancelPaymentFlow } from './flows/cancel-payment.flow';
import { CapturePaymentFlow } from './flows/capture-payment.flow';
import { ConfirmPaymentFlow } from './flows/confirm-payment.flow';
import { PaymentIntentEntity } from './payment-intent.entity';
import { PaymentIntentRepository } from './payment-intent.repository';
import { PaymentIntentsController } from './payment-intents.controller';
import { PaymentIntentsService } from './payment-intents.service';
import { ProcessorWebhookController } from './processor-webhook.controller';
import { ProcessorWebhookService } from './processor-webhook.service';
import { AcquirerHttpClient } from './processor/acquirer-http.client';
import { NordpayAdapter } from './processor/nordpay.adapter';
import { PROCESSOR_ADAPTERS, type ProcessorAdapter } from './processor/processor.adapter';
import { ProcessorRouter } from './processor/processor.router';
import { ProcessorSignatureVerifier } from './processor/processor-signature.verifier';
import { SandboxProcessorAdapter } from './processor/sandbox.adapter';
import { WorldflowAdapter } from './processor/worldflow.adapter';
import { ChargeStateMachine } from './state/charge.state-machine';
import { PaymentIntentStateMachine } from './state/payment-intent.state-machine';
import { VaultClient } from './vault/vault.client';

/** Per-acquirer client token. Two instances, two base URLs, one class. */
const WORLDFLOW_HTTP = Symbol('WORLDFLOW_HTTP');
const NORDPAY_HTTP = Symbol('NORDPAY_HTTP');

@Module({
  imports: [
    CommonModule,
    ApiModule,
    MerchantsModule,
    LedgerModule,
    EventsModule,
    AuditModule,
    forwardRef(() => RefundsModule),
    forwardRef(() => DisputesModule),
    TypeOrmModule.forFeature([PaymentIntentEntity, ChargeEntity]),
  ],
  controllers: [PaymentIntentsController, ChargesController, ProcessorWebhookController],
  providers: [
    PaymentIntentsService,
    PaymentIntentRepository,
    ChargesService,
    ChargeRepository,
    ChargeAuthorizationService,
    ChargeCaptureService,
    ChargeExpiryPolicy,
    ConfirmPaymentFlow,
    CapturePaymentFlow,
    CancelPaymentFlow,
    PaymentIntentStateMachine,
    ChargeStateMachine,
    ProcessorWebhookService,

    {
      // Production code, reached only by `sk_test_` principals — the router hands it every
      // request whose principal is not livemode. It takes the Clock explicitly so its
      // deterministic "settles in 2 days" responses move with a FixedClock in the e2e suite.
      provide: SandboxProcessorAdapter,
      inject: [CLOCK],
      useFactory: (clock: Clock): SandboxProcessorAdapter => new SandboxProcessorAdapter(clock),
    },

    {
      provide: ProcessorSignatureVerifier,
      inject: [ApiConfig, CLOCK],
      useFactory: (config: ApiConfig, clock: Clock): ProcessorSignatureVerifier =>
        new ProcessorSignatureVerifier(
          {
            worldflow: config.acquirers.worldflowApiKey,
            nordpay: config.acquirers.nordpayApiKey,
          },
          clock,
        ),
    },

    {
      provide: WORLDFLOW_HTTP,
      inject: [ApiConfig, HTTP_TRANSPORT, PAYZENO_LOGGER, CircuitBreakerRegistry],
      useFactory: (
        config: ApiConfig,
        transport: HttpTransport,
        logger: PayzenoLogger,
        breakers: CircuitBreakerRegistry,
      ): AcquirerHttpClient =>
        new AcquirerHttpClient(
          {
            acquirer: 'worldflow',
            baseUrl: config.acquirers.worldflowBaseUrl,
            apiKey: config.acquirers.worldflowApiKey,
            acquirerAccountId: 'payzeno-platform',
          },
          transport,
          { ...DEFAULT_CLIENT_OPTIONS, readTimeoutMs: 20_000, userAgent: 'payzeno-api/worldflow' },
          // Authorisations carry an idempotency key, so a retry is safe by contract. That is
          // the ONLY reason retries are on for an acquirer at all.
          new IdempotentRetryPolicy(2),
          logger,
          breakers,
        ),
    },
    {
      provide: NORDPAY_HTTP,
      inject: [ApiConfig, HTTP_TRANSPORT, PAYZENO_LOGGER, CircuitBreakerRegistry],
      useFactory: (
        config: ApiConfig,
        transport: HttpTransport,
        logger: PayzenoLogger,
        breakers: CircuitBreakerRegistry,
      ): AcquirerHttpClient =>
        new AcquirerHttpClient(
          {
            acquirer: 'nordpay',
            baseUrl: config.acquirers.nordpayBaseUrl,
            apiKey: config.acquirers.nordpayApiKey,
            acquirerAccountId: 'payzeno-platform',
          },
          transport,
          { ...DEFAULT_CLIENT_OPTIONS, readTimeoutMs: 20_000, userAgent: 'payzeno-api/nordpay' },
          new IdempotentRetryPolicy(2),
          logger,
          breakers,
        ),
    },

    {
      provide: WorldflowAdapter,
      inject: [WORLDFLOW_HTTP, ProcessorSignatureVerifier],
      useFactory: (http: AcquirerHttpClient, verifier: ProcessorSignatureVerifier): WorldflowAdapter =>
        new WorldflowAdapter(http, verifier),
    },
    {
      provide: NordpayAdapter,
      inject: [NORDPAY_HTTP, ProcessorSignatureVerifier],
      useFactory: (http: AcquirerHttpClient, verifier: ProcessorSignatureVerifier): NordpayAdapter =>
        new NordpayAdapter(http, verifier),
    },
    {
      provide: PROCESSOR_ADAPTERS,
      inject: [WorldflowAdapter, NordpayAdapter],
      useFactory: (worldflow: WorldflowAdapter, nordpay: NordpayAdapter): ProcessorAdapter[] => [
        worldflow,
        nordpay,
      ],
    },
    {
      provide: ProcessorRouter,
      inject: [PROCESSOR_ADAPTERS, SandboxProcessorAdapter, PAYZENO_LOGGER, ApiConfig],
      useFactory: (
        adapters: ProcessorAdapter[],
        sandbox: SandboxProcessorAdapter,
        logger: PayzenoLogger,
        config: ApiConfig,
      ): ProcessorRouter => new ProcessorRouter(adapters, sandbox, logger, config.acquirers.defaultAcquirer),
    },

    {
      provide: VaultClient,
      inject: [ApiConfig, HTTP_TRANSPORT, PAYZENO_LOGGER],
      useFactory: (config: ApiConfig, transport: HttpTransport, logger: PayzenoLogger): VaultClient =>
        new VaultClient(
          { baseUrl: config.vault.baseUrl, apiKey: config.vault.apiKey },
          transport,
          { ...DEFAULT_CLIENT_OPTIONS, readTimeoutMs: 5_000, retries: 0, userAgent: 'payzeno-api/vault' },
          // No retries into the vault. A token resolve is cheap to fail and expensive to
          // duplicate — arc PCI wants exactly one resolution per authorisation in the audit.
          new NoRetryPolicy(),
          logger,
        ),
    },
  ],
  exports: [
    PaymentIntentsService,
    ChargesService,
    ChargeRepository,
    PaymentIntentRepository,
    ChargeCaptureService,
    ChargeExpiryPolicy,
    ChargeStateMachine,
    ProcessorRouter,
    VaultClient,
  ],
})
export class PaymentsModule {}
