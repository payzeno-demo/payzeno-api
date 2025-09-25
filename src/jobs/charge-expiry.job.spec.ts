import 'reflect-metadata';

import { InMemoryLock } from '../common/lock/distributed-lock';

import { ChargeExpiryJob } from './charge-expiry.job';

describe('ChargeExpiryJob', () => {
  const now = new Date('2026-05-07T00:00:00.000Z');
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  function charge(id: string, expiresAt: string | null) {
    return {
      id,
      merchantId: 'mch_1',
      amount_minor: 25_000,
      currency: 'USD',
      livemode: true,
      authorization_expires_at: expiresAt ? new Date(expiresAt) : null,
    };
  }

  let charges: { findExpiredAuthorizations: jest.Mock; markExpired: jest.Mock };
  let expiry: { isExpired: jest.Mock };
  let ledger: { releaseAuthorization: jest.Mock };
  let job: ChargeExpiryJob;

  beforeEach(() => {
    jest.clearAllMocks();
    charges = {
      findExpiredAuthorizations: jest.fn(async () => [charge('ch_1', '2026-04-30T00:00:00.000Z')]),
      markExpired: jest.fn(async () => 1),
    };
    expiry = { isExpired: jest.fn(() => true) };
    ledger = { releaseAuthorization: jest.fn(async () => ({ id: 'txn_release' })) };

    job = new ChargeExpiryJob(
      charges as never,
      expiry as never,
      ledger as never,
      { runInTransaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}) } as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      new InMemoryLock(),
      logger as never,
    );
  });

  it('expires the charge and releases the hold in the ledger', async () => {
    const result = await job.runOnce();

    expect(charges.markExpired).toHaveBeenCalledWith({}, 'ch_1');
    expect(ledger.releaseAuthorization).toHaveBeenCalledWith({
      chargeId: 'ch_1',
      merchantId: 'mch_1',
      currency: 'USD',
      livemode: true,
      amountMinor: 25_000,
    });
    expect(result.details).toMatchObject({ expired: 1 });
  });

  it('re-asks the policy — a mis-stamped window must not expire a live authorisation', async () => {
    expiry.isExpired.mockReturnValueOnce(false);

    const result = await job.runOnce();

    expect(charges.markExpired).not.toHaveBeenCalled();
    expect(ledger.releaseAuthorization).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ expired: 0 });
  });

  it('does not post a release when the row was captured between read and write', async () => {
    charges.markExpired.mockResolvedValueOnce(0);

    const result = await job.runOnce();

    expect(ledger.releaseAuthorization).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({ expired: 0 });
    expect(result.failed).toBe(0);
  });

  it('leaves the row authorized when the ledger call fails, so the next hour retries', async () => {
    ledger.releaseAuthorization.mockRejectedValueOnce(new Error('ledger unavailable'));

    const result = await job.runOnce();

    expect(result.failed).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      'charge_expiry.failed',
      expect.any(Error),
      expect.objectContaining({ charge_id: 'ch_1' }),
    );
  });

  it('reports truncated when it hits the per-run cap', async () => {
    charges.findExpiredAuthorizations.mockResolvedValueOnce(
      Array.from({ length: 500 }, (_, i) => charge(`ch_${i}`, '2026-04-30T00:00:00.000Z')),
    );

    const result = await job.runOnce();

    expect(result.truncated).toBe(true);
    expect(result.processed).toBe(500);
  });

  it('skips when another task holds the lease', async () => {
    const lock = new InMemoryLock();
    await lock.acquire('charge-expiry', 900);

    const result = await new ChargeExpiryJob(
      charges as never,
      expiry as never,
      ledger as never,
      { runInTransaction: jest.fn() } as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      lock,
      logger as never,
    ).runOnce();

    expect(result.details).toEqual({ skipped: 'lock_not_acquired' });
    expect(charges.findExpiredAuthorizations).not.toHaveBeenCalled();
  });
});
