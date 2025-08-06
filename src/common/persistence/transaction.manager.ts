/**
 * TransactionManager — the transaction boundary for every multi-aggregate write.
 *
 * Two rules, both from docs/adr/0011-outbox-over-direct-publish.md:
 *
 *   1. The outbox write happens INSIDE the business transaction. `OutboxEventPublisher` takes
 *      the same EntityManager the caller is holding, so a rolled-back capture cannot leave a
 *      `payment.captured` event behind, and a committed capture cannot fail to emit one.
 *   2. READ COMMITTED, everywhere. We do not set an isolation level anywhere in this repo.
 *      A retry blocked on a row lock must re-evaluate its predicate against data the winner
 *      has since committed; under REPEATABLE READ the snapshot predates the lock wait and the
 *      re-read still sees the stale row. That is the correctness argument behind the ledger's
 *      PAY-2043 hotfix and it applies identically on this side.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { isSerializationFailure, mapTypeOrmError } from './typeorm-error.mapper';

/**
 * The in-flight EntityManager, so `OutboxEventPublisher.publish` can find the caller's
 * transaction without every business method threading a manager through its signature. That
 * is what makes "the outbox row is written inside the business transaction" (ADR 0011) true
 * by construction rather than by everyone remembering to pass an argument.
 */
const active = new AsyncLocalStorage<EntityManager>();

