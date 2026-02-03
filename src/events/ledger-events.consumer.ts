import { SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { EntityManager } from 'typeorm';
import {
  type EventType,
  isEventOfType,
  type PayzenoEvent,
  type SettlementCompletedPayload,
  type SettlementDuplicateDetectedPayload,
  type SettlementVarianceDetectedPayload,
} from '@payzeno/contracts/events';
import { API_CONFIG } from '../config/config.module';
import type { ApiConfig } from '../config/api-config.type';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { TransactionManager } from '../common/persistence/transaction.manager';
import { AuditService } from '../audit/audit.service';
import { ChargesService } from '../payments/charges.service';
import { MerchantsService } from '../merchants/merchants.service';
import { SupportTasksService } from '../support/support-tasks.service';
import { BaseEventConsumer } from './consumer';
import { ProcessedEventRepository } from './processed-event.repository';
import { SettlementCompletion } from './settlement-completion.entity';

/**
 * Queue `payzeno-api-ledger`. The API side of the money path.
 *
 * This file is arc INC's blast radius. Two of its branches were written at 02:40 on the
 * night of PAY-2041 and hardened over the following fortnight:
 *
 *   settlement.completed          chunk accounting (PAY-2052, migration 25). The event is
 *                                 the SOLE driver of `charge captured -> settled` and it is
 *                                 chunked at 1000 ids over an unordered at-least-once bus.
 *   settlement.duplicate_detected added by the hotfix. Writes an audit row always, and opens
 *                                 a support task when the merchant is on capture-at-settlement
 *                                 — those are the merchants who can actually be double-charged.
 *
 * Collaborators are resolved through `ModuleRef` in `onModuleInit`, not constructor-injected,
