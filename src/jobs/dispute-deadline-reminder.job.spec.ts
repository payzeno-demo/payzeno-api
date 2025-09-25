import 'reflect-metadata';

import { InMemoryLock } from '../common/lock/distributed-lock';

import { DisputeDeadlineReminderJob } from './dispute-deadline-reminder.job';

describe('DisputeDeadlineReminderJob', () => {
  const now = new Date('2026-05-05T07:00:00.000Z');
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  function dispute(id: string, dueBy: string) {
    return {
      id,
      merchantId: 'mch_1',
      chargeId: 'ch_1',
      amountMinor: 12_500,
      evidenceDueBy: new Date(dueBy),
    };
  }

  let disputes: { listPendingEvidence: jest.Mock; closeAsLost: jest.Mock };
  let job: DisputeDeadlineReminderJob;

  beforeEach(() => {
    jest.clearAllMocks();
    disputes = {
      listPendingEvidence: jest.fn(async (before: Date) =>
        before.getTime() <= now.getTime()
          ? [dispute('dp_overdue', '2026-05-04T00:00:00.000Z')]
          : [
              dispute('dp_overdue', '2026-05-04T00:00:00.000Z'),
              dispute('dp_soon', '2026-05-07T07:00:00.000Z'),
            ],
      ),
      closeAsLost: jest.fn(async () => undefined),
    };

    job = new DisputeDeadlineReminderJob(
      disputes as never,
      { now: () => now, nowMs: () => now.getTime() } as never,
      new InMemoryLock(),
      logger as never,
    );
  });

  it('closes overdue disputes as lost so the ledger releases the held amount', async () => {
    const result = await job.runOnce();

    expect(disputes.closeAsLost).toHaveBeenCalledWith('dp_overdue', 'evidence_window_elapsed');
    expect(result.details).toMatchObject({ expired: 1 });
  });

  it('warns about disputes due inside the 72h window but does not close them', async () => {
    await job.runOnce();

    expect(logger.warn).toHaveBeenCalledWith(
      'dispute.evidence_due_soon',
      expect.objectContaining({ dispute_id: 'dp_soon', hours_left: 48 }),
    );
    expect(disputes.closeAsLost).toHaveBeenCalledTimes(1);
  });

  it('does not remind about a dispute that is already overdue — it was just closed', async () => {
    await job.runOnce();

    const reminded = logger.warn.mock.calls
      .filter(([msg]) => msg === 'dispute.evidence_due_soon')
      .map(([, ctx]) => (ctx as { dispute_id: string }).dispute_id);

    expect(reminded).not.toContain('dp_overdue');
  });

  it('keeps going when one dispute refuses to transition', async () => {
    disputes.listPendingEvidence.mockImplementationOnce(async () => [
      dispute('dp_a', '2026-05-04T00:00:00.000Z'),
      dispute('dp_b', '2026-05-04T00:00:00.000Z'),
    ]);
    disputes.closeAsLost.mockRejectedValueOnce(new Error('invalid transition'));

    const result = await job.runOnce();

    expect(result.details).toMatchObject({ expired: 1 });
    expect(logger.error).toHaveBeenCalledWith(
      'dispute.expire_failed',
      expect.any(Error),
      expect.objectContaining({ dispute_id: 'dp_a' }),
    );
  });

  it('skips when another task holds the lease', async () => {
    const lock = new InMemoryLock();
    await lock.acquire('dispute-deadline-reminder', 600);

    const result = await new DisputeDeadlineReminderJob(
      disputes as never,
      { now: () => now } as never,
      lock,
      logger as never,
    ).runOnce();

    expect(result.details).toEqual({ skipped: 'lock_not_acquired' });
    expect(disputes.listPendingEvidence).not.toHaveBeenCalled();
  });
});
