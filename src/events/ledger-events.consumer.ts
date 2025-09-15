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
