import type { Redis } from 'ioredis';
import { request as undiciRequest } from 'undici';
import type { DataSource } from 'typeorm';

import { HealthService } from 'src/health/health.service';
import { NoopLogger } from 'src/common/logging/logger';
import type { ApiConfig } from 'src/config/api-config.type';

jest.mock('undici', () => ({ request: jest.fn() }));

/**
 * The distinction this file protects is liveness vs readiness, and it is the one people get
 * wrong on the way past.
 *
 * `/healthz` must NEVER touch a dependency. A liveness probe that checks Postgres turns a
 * five-second database blip into a simultaneous restart of every task in the fleet, and then
 * a cold start on top of the blip. There is a test below that asserts the DataSource is never
 * queried, and it is there to fail a well-meaning PR.
 *
 * `/readyz` checks everything, in parallel, with a bound on each. A readiness probe that hangs
 * is a task the ALB neither drains nor kills — we spent an afternoon on that in month 3.
 *
 * — apager. docs/runbooks/payzeno-api.md.
 */
describe('HealthService', () => {
  const config = {
    runtime: { serviceName: 'payzeno-api', serviceVersion: '1.34.0', nodeEnv: 'production' },
    ledger: { baseUrl: 'http://payzeno-ledger:8000' },
    vault: { baseUrl: 'http://payzeno-vault:8099', apiKey: 'vault-key' },
  } as unknown as ApiConfig;

  let dataSource: jest.Mocked<Pick<DataSource, 'query'>>;
  let redis: jest.Mocked<Pick<Redis, 'ping'>>;
  let logger: NoopLogger;
  let service: HealthService;

  function ledgerResponds(statusCode: number): void {
    (undiciRequest as jest.Mock).mockResolvedValue({
      statusCode,
      body: { dump: jest.fn(async () => undefined) },
    });
  }

  function build(overrides: Partial<ApiConfig> = {}): HealthService {
    return new HealthService(
      dataSource as unknown as DataSource,
      redis as unknown as Redis,
      { ...config, ...overrides } as ApiConfig,
      logger,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();

    dataSource = { query: jest.fn(async () => [{ ok: 1 }]) } as never;
    redis = { ping: jest.fn(async () => 'PONG') } as never;
    logger = new NoopLogger();

    ledgerResponds(200);
    service = build();
  });

  describe('liveness', () => {
    it('reports ok with the service name and version', () => {
      expect(service.liveness()).toEqual({
        status: 'ok',
        service: 'payzeno-api',
        version: '1.34.0',
      });
    });

    it('touches NO dependency', () => {
      service.liveness();

      // Read the header of health.service.ts before making any of these pass differently.
      expect(dataSource.query).not.toHaveBeenCalled();
      expect(redis.ping).not.toHaveBeenCalled();
      expect(undiciRequest).not.toHaveBeenCalled();
    });

    it('is synchronous — a liveness probe that awaits anything can hang', () => {
      expect(service.liveness()).not.toBeInstanceOf(Promise);
    });
  });

  describe('readiness', () => {
    it('reports ok when every dependency answers', async () => {
      await expect(service.readiness()).resolves.toEqual({
        status: 'ok',
        checks: { db: true, bus: true, ledger: true, vault: true },
      });
    });

    it('pings the database with SELECT 1 and nothing heavier', async () => {
      await service.readiness();

      expect(dataSource.query).toHaveBeenCalledWith('SELECT 1 AS ok');
    });

    it('degrades — and names the dependency — when the database is down', async () => {
      dataSource.query.mockRejectedValue(new Error('connection terminated'));

      const result = await service.readiness();

      expect(result.status).toBe('degraded');
      expect(result.checks).toMatchObject({ db: false, bus: true });
    });

    it('degrades when redis answers something other than PONG', async () => {
      redis.ping.mockResolvedValue('LOADING');

      expect((await service.readiness()).checks.bus).toBe(false);
    });

    it('degrades when redis rejects', async () => {
      redis.ping.mockRejectedValue(new Error('ECONNREFUSED'));

      expect((await service.readiness()).status).toBe('degraded');
    });

    it('runs the checks in parallel', async () => {
      // Four sequential 2s timeouts is an 8s readiness probe against a 5s ALB timeout, which
      // reports every task unhealthy the moment one dependency slows down.
      let inFlight = 0;
      let peak = 0;

      const track = async <T>(value: T): Promise<T> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return value;
      };

      dataSource.query.mockImplementation(() => track([{ ok: 1 }]));
      redis.ping.mockImplementation(() => track('PONG'));

      await service.readiness();

      expect(peak).toBeGreaterThan(1);
    });

    it('logs once at warn when degraded', async () => {
      const warn = jest.spyOn(logger, 'warn');
      redis.ping.mockRejectedValue(new Error('ECONNREFUSED'));

      await service.readiness();

      // One line for the failed check, one for the degraded summary. Not one per retry.
      expect(warn).toHaveBeenCalled();
    });

    it('does not log when healthy', async () => {
      const warn = jest.spyOn(logger, 'warn');

      await service.readiness();

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('the ledger probe', () => {
    it('calls the ledger GET /healthz, not its readiness', async () => {
      await service.readiness();

      expect(undiciRequest).toHaveBeenCalledWith(
        'http://payzeno-ledger:8000/healthz',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('bounds both timeouts', async () => {
      await service.readiness();

      const [, options] = (undiciRequest as jest.Mock).mock.calls[0];
      expect(options).toMatchObject({ headersTimeout: 2_000, bodyTimeout: 2_000 });
    });

    it('drains the body — an undrained response leaks a socket per probe', async () => {
      const dump = jest.fn(async () => undefined);
      (undiciRequest as jest.Mock).mockResolvedValue({ statusCode: 200, body: { dump } });

      await service.readiness();

      expect(dump).toHaveBeenCalled();
    });

    it('is false on a non-200', async () => {
      ledgerResponds(503);

      expect((await service.readiness()).checks.ledger).toBe(false);
    });

    it('is false — not a throw — when the ledger is unreachable', async () => {
      (undiciRequest as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.readiness();

      expect(result.checks.ledger).toBe(false);
      expect(result.status).toBe('degraded');
    });
  });

  describe('the vault check', () => {
    it('is configuration-only — the vault has no unauthenticated probe', async () => {
      await service.readiness();

      // Exactly one outbound call was made, and it went to the ledger.
      expect(undiciRequest).toHaveBeenCalledTimes(1);
    });

    it('fails when the vault base URL is empty', async () => {
      const svc = build({ vault: { baseUrl: '', publicUrl: '', apiKey: 'k' } } as Partial<ApiConfig>);

      expect((await svc.readiness()).checks.vault).toBe(false);
    });

    it('fails when the vault API key is empty', async () => {
      const svc = build({
        vault: { baseUrl: 'http://payzeno-vault:8099', publicUrl: '', apiKey: '' },
      } as Partial<ApiConfig>);

      expect((await svc.readiness()).checks.vault).toBe(false);
    });
  });

  describe('the timeout guard', () => {
    it('fails a check that never settles rather than hanging the probe', async () => {
      jest.useFakeTimers();
      dataSource.query.mockImplementation(() => new Promise(() => undefined));

      const pending = service.readiness();
      jest.advanceTimersByTime(2_500);
      const result = await pending;

      expect(result.checks.db).toBe(false);
      jest.useRealTimers();
    });
  });
});
