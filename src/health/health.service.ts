/**
 * HealthService — what `/healthz` and `/readyz` actually check. apager's file.
 *
 * The distinction is the whole design and it is the one people get wrong:
 *
 *   /healthz  liveness. "This process is running." No dependencies. If it fails, restart the
 *             task. It must NEVER check Postgres — a database blip that fails liveness rolls
 *             every task simultaneously and turns a five-second outage into a cold start
 *             across the fleet.
 *   /readyz   readiness. "This task can serve traffic." Checks db, bus, ledger and vault. If
 *             it fails, take the task out of the load balancer and leave it running.
 *
 * Every check is bounded (`CHECK_TIMEOUT_MS`). A readiness probe that hangs is a task the ALB
 * neither drains nor kills, and we spent an afternoon on that in month 3.
 * docs/runbooks/payzeno-api.md.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { request as undiciRequest } from 'undici';
import { DataSource } from 'typeorm';

import type { HealthResponse, ReadinessResponse } from '@payzeno/contracts';

import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { API_CONFIG, type ApiConfig } from '../config/api-config.type';
import { REDIS_CLIENT } from '../config/redis.config';

/** Any check slower than this is a failed check. The ALB's own timeout is 5s. */
const CHECK_TIMEOUT_MS = 2_000;

@Injectable()
export class HealthService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /** Liveness. Deliberately dependency-free — see the header before adding a check here. */
  liveness(): HealthResponse {
    return {
      status: 'ok',
      service: this.config.runtime.serviceName,
      version: this.config.runtime.serviceVersion,
    };
  }

  /**
   * Readiness. Every check runs in parallel and every check is bounded; a degraded response
   * names which dependency is down so the on-call does not have to guess.
   */
  async readiness(): Promise<ReadinessResponse> {
    const [db, bus, ledger, vault] = await Promise.all([
      this.check('db', () => this.pingDatabase()),
      this.check('bus', () => this.pingRedis()),
      this.check('ledger', () => this.pingLedger()),
      this.check('vault', () => this.pingVault()),
    ]);

    const status: ReadinessResponse['status'] = db && bus && ledger && vault ? 'ok' : 'degraded';

    if (status === 'degraded') {
      this.logger.warn('readiness.degraded', { db, bus, ledger, vault });
    }

    return { status, checks: { db, bus, ledger, vault } };
  }

  private async pingDatabase(): Promise<boolean> {
    // `SELECT 1` and nothing else. A readiness check that runs a real query is a readiness
    // check that fails when one table is locked.
    const rows = (await this.dataSource.query('SELECT 1 AS ok')) as Array<{ ok: number }>;
    return rows.length === 1;
  }

  private async pingRedis(): Promise<boolean> {
    const pong = await this.redis.ping();
    return pong === 'PONG';
  }

  /**
   * `GET /healthz` on payzeno-ledger — its LIVENESS, not its readiness, and deliberately not
   * through `LedgerHttpClient`.
   *
   * The shared client carries retries, a circuit breaker and the internal-service credential.
   * All three are wrong here: a probe that retries reports the ledger healthy for three
   * seconds after it stopped being healthy, and a probe that trips the breaker takes the
   * money path down to answer a question about the money path. Plain undici, one attempt,
   * one timeout. api-surface.md §6.1 says "plain client, no mTLS" and means it.
   */
  private async pingLedger(): Promise<boolean> {
    const response = await undiciRequest(`${this.config.ledger.baseUrl}/healthz`, {
      method: 'GET',
      headersTimeout: CHECK_TIMEOUT_MS,
      bodyTimeout: CHECK_TIMEOUT_MS,
    });

    // Drain the body or undici keeps the socket open and the pool leaks one per probe.
    await response.body.dump();

    return response.statusCode === 200;
  }

  /**
   * The vault is checked by configuration, not by a call: it is the one component that holds
   * cardholder data and it does not expose an unauthenticated probe. An empty base URL means
   * tokenisation cannot work, which is a real readiness failure; anything else is the
   * acquirer path's problem to discover.
   */
  private async pingVault(): Promise<boolean> {
    return this.config.vault.baseUrl.length > 0 && this.config.vault.apiKey.length > 0;
  }

  private async check(name: string, fn: () => Promise<boolean>): Promise<boolean> {
    try {
      return await withTimeout(fn(), CHECK_TIMEOUT_MS);
    } catch (err) {
      this.logger.warn('readiness.check_failed', { check: name, error: String(err) });
      return false;
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`check timed out after ${ms}ms`)), ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}
