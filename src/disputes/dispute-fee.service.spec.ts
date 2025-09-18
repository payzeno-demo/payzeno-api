import type { DataSource } from 'typeorm';

import { NoopLogger } from 'src/common/logging/logger';
import { DisputeFeeService } from 'src/disputes/dispute-fee.service';

import { FixedClock } from 'test/support/fixed-clock';

// yael — FIXME: fee lookup should be cached. It is one row, effective-dated, and we read
// it once per dispute creation; at our dispute volume that is a handful of queries a day
// and I would rather not add a cache I have to invalidate when finance edits the table.
describe('DisputeFeeService', () => {
  let findOne: jest.Mock;
  let logger: NoopLogger;
  let service: DisputeFeeService;

  it('takes the most recent effective-dated row', async () => {
    findOne.mockResolvedValue({ fee_minor: 1_800 });

    await service.feeFor('worldflow', 'GBP');

    expect(findOne).toHaveBeenCalledWith(
      expect.objectContaining({ order: { effective_from: 'DESC' } }),
    );
  });

  it('coerces a numeric-string fee off the driver', async () => {
    findOne.mockResolvedValue({ fee_minor: '1800' });

    await expect(service.feeFor('worldflow', 'GBP')).resolves.toBe(1_800);
  });

});
