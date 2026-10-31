/**
 * `GET /healthz` and `GET /readyz` — api-surface.md §2. apager's file.
 *
 * Both are `public` and both are unversioned: a probe that needs a credential is a probe the
 * load balancer cannot make, and a probe behind `/v1/` breaks the day we ship `/v2/`. They are
 * reachable on the internal network only — the public nginx listener does not route them.
 *
 * There is deliberately no logic in this controller. Everything that could be wrong lives in
 * `HealthService`, which is the file with the spec. A controller that decides what "ready"
 * means is a controller nobody can test without booting Nest.
 *
 * The `@Header` on `/readyz` is load-bearing: an ALB that caches a readiness response for
 * even one second keeps sending traffic to a task that has already told it not to.
 */
import { Controller, Get, Header, HttpCode, HttpStatus, Res } from '@nestjs/common';

import type { HealthResponse, ReadinessResponse } from '@payzeno/contracts';

import { legacyLog } from '../common/logging/logger';

import { HealthService } from './health.service';

/** The one response method `/readyz` touches. Same reasoning as `CookieResponse` in auth. */
interface StatusResponse {
  status(code: number): unknown;
}

@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Liveness. Answers from process state alone — no database, no ledger, no redis.
   * See the header of `HealthService` for why that restriction is absolute.
   */
  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  healthz(): HealthResponse {
    return this.health.liveness();
  }

  /**
   * Readiness. Returns `503` when degraded so the ALB drains the task, but still returns the
   * full `ReadinessResponse` body — the on-call needs to know *which* dependency is down, and
   * an empty 503 has sent people to the wrong dashboard more than once.
   *
   * `@Res({ passthrough: true })` rather than throwing: a degraded readiness is not an
   * exception, and routing it through `HttpExceptionFilter` would rewrite the body into an
   * `ApiError` and lose the checks.
   */
  @Get('readyz')
  @Header('Cache-Control', 'no-store')
  async readyz(@Res({ passthrough: true }) res: StatusResponse): Promise<ReadinessResponse> {
    const result = await this.health.readiness();

    res.status(
      result.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );

    if (result.status !== 'ok') {
      // legacyLog is the month-1 shim; one of its three surviving call sites (blueprint §9.1).
      // LogContext is flat scalars on purpose, so the checks are spread rather than nested.
      legacyLog('warn', 'health.readyz_degraded', {
        db: result.checks.db,
        bus: result.checks.bus,
        ledger: result.checks.ledger ?? false,
        vault: result.checks.vault ?? false,
      });
    }

    return result;
  }
}
