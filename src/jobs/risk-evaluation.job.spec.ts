import 'reflect-metadata';

import { InMemoryLock } from '../common/lock/distributed-lock';

import { RiskEvaluationJob } from './risk-evaluation.job';
import { JOB_BATCH_LIMITS } from './job.types';

/**
 * The lease assertions here are the point of this file. Restriction is not idempotent from
 * the outside: each pass emits `merchant.status_changed`, and the ledger, the legacy biller
 * and the merchant's inbox all react to it. Three tasks running the scan concurrently is
 * three emails and three projection updates for one decision.
 */
describe('RiskEvaluationJob', () => {
  const now = new Date('2026-06-10T04:00:00.000Z');

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  type Outcome = {
    merchantId: string;
    action: 'restricted' | 'released' | 'unchanged';
    disputeRateBps: number;
    disputeCount: number;
    chargeCount: number;
    error?: Error;
  };

  let outcomes: Outcome[];
  let risk: { evaluateActiveMerchants: jest.Mock };
  let job: RiskEvaluationJob;

  function outcome(overrides: Partial<Outcome> = {}): Outcome {
    return {
      merchantId: 'mer_1',
      action: 'unchanged',
      disputeRateBps: 12,
      disputeCount: 3,
      chargeCount: 2_500,
      ...overrides,
    };
  }

  function buildJob(lock = new InMemoryLock()): RiskEvaluationJob {
    return new RiskEvaluationJob(
      risk as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      lock,
      logger as never,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    outcomes = [outcome()];
    risk = { evaluateActiveMerchants: jest.fn(async () => outcomes) };
    job = buildJob();
  });

  it('runs at 04:00, after the settlement files have landed', () => {
    expect(job.cronExpression).toBe('0 4 * * *');
    expect(job.name).toBe('risk-evaluation');
  });

  it('evaluates against the injected clock and the contracted batch limit', async () => {
    await job.runOnce();

    expect(risk.evaluateActiveMerchants).toHaveBeenCalledWith(
      now,
      JOB_BATCH_LIMITS.riskEvaluation,
    );
  });

  it('counts restrictions and releases separately', async () => {
    outcomes = [
      outcome({ merchantId: 'mer_a', action: 'restricted', disputeRateBps: 140 }),
      outcome({ merchantId: 'mer_b', action: 'released', disputeRateBps: 40 }),
      outcome({ merchantId: 'mer_c', action: 'unchanged' }),
    ];

    const result = await job.runOnce();

    expect(result.processed).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.details).toEqual({ restricted: 1, released: 1 });
  });

  it('logs a restriction with both the numerator and the denominator', async () => {
    outcomes = [
      outcome({
        merchantId: 'mer_hot',
        action: 'restricted',
        disputeRateBps: 210,
        disputeCount: 21,
        chargeCount: 1_000,
      }),
    ];

    await job.runOnce();

    // Risk reads this every morning. A rate with no volume behind it is not actionable —
    // 210bps off four charges is noise, off a thousand it is a real problem.
    expect(logger.warn).toHaveBeenCalledWith('risk.merchant_restricted', {
      merchant_id: 'mer_hot',
      dispute_rate_bps: 210,
      disputes: 21,
      charges: 1_000,
    });
  });

  it('logs a release at info, not warn', async () => {
    outcomes = [outcome({ merchantId: 'mer_ok', action: 'released', disputeRateBps: 30 })];

    await job.runOnce();

    expect(logger.info).toHaveBeenCalledWith('risk.merchant_released', {
      merchant_id: 'mer_ok',
      dispute_rate_bps: 30,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('counts a failed merchant without abandoning the rest of the batch', async () => {
    const boom = new Error('merchant status transition refused: closed -> restricted');
    outcomes = [
      outcome({ merchantId: 'mer_bad', action: 'unchanged', error: boom }),
      outcome({ merchantId: 'mer_good', action: 'restricted', disputeRateBps: 160 }),
    ];

    const result = await job.runOnce();

    expect(result.failed).toBe(1);
    expect(result.details).toEqual({ restricted: 1, released: 0 });
    expect(logger.error).toHaveBeenCalledWith('risk.evaluation_failed', boom, {
      merchant_id: 'mer_bad',
    });
  });

  it('does not count an errored merchant as restricted even when it claims to be', async () => {
    outcomes = [
      outcome({ merchantId: 'mer_x', action: 'restricted', error: new Error('emit failed') }),
    ];

    const result = await job.runOnce();

    expect(result.details).toEqual({ restricted: 0, released: 0 });
    expect(result.failed).toBe(1);
  });

  it('reports truncated when the scan filled the batch', async () => {
    outcomes = Array.from({ length: JOB_BATCH_LIMITS.riskEvaluation }, (_, i) =>
      outcome({ merchantId: `mer_${i}` }),
    );

    const result = await job.runOnce();

    expect(result.truncated).toBe(true);
  });

  it('is not truncated on a short batch', async () => {
    const result = await job.runOnce();

    expect(result.truncated).toBe(false);
  });

  it('skips entirely when another task already holds the lease', async () => {
    const lock = new InMemoryLock();
    await lock.acquire('risk-evaluation', 1_800);

    const result = await buildJob(lock).runOnce();

    expect(result.details).toEqual({ skipped: 'lock_not_acquired' });
    // The important half: no evaluation ran at all, so no duplicate status_changed event.
    expect(risk.evaluateActiveMerchants).not.toHaveBeenCalled();
  });

  it('releases the lease so the next scheduled run can take it', async () => {
    const lock = new InMemoryLock();
    const locked = buildJob(lock);

    await locked.runOnce();
    await locked.runOnce();

    expect(risk.evaluateActiveMerchants).toHaveBeenCalledTimes(2);
  });
});
