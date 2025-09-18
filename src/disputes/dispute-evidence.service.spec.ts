import { ValidationException } from 'src/common/errors/api.exception';
import { DisputeWindowClosedException } from 'src/common/errors/business.exceptions';
import { NoopLogger } from 'src/common/logging/logger';
import { DisputeEvidenceService, EVIDENCE_FIELDS } from 'src/disputes/dispute-evidence.service';

import { FixedClock } from 'test/support/fixed-clock';

/**
 * Evidence handling. The merge behaviour is the part with a bug history: the console
 * autosaves section by section, and a submission that REPLACED the blob deleted whatever
 * the merchant filled in yesterday (PAY-1712).
 */
describe('DisputeEvidenceService', () => {
  let service: DisputeEvidenceService;
  let clock: FixedClock;

  function dispute(overrides: Record<string, unknown> = {}) {
    return {
      id: 'dp_1',
      status: 'needs_response',
      reason: 'fraudulent',
      evidence: {},
      evidence_due_by: new Date('2026-02-01T00:00:00.000Z'),
      ...overrides,
    } as never;
  }

  beforeEach(() => {
    clock = new FixedClock('2026-01-15T12:00:00.000Z');
    service = new DisputeEvidenceService(clock, new NoopLogger());
  });

  describe('normalise', () => {
    it('merges over what was staged before rather than replacing it', () => {
      const merged = service.normalise(
        { customer_name: 'A. Customer' },
        { shipping_tracking_number: 'TRK-1' },
      );

      expect(merged).toEqual({ customer_name: 'A. Customer', shipping_tracking_number: 'TRK-1' });
    });

    it('leaves untouched fields alone', () => {
      const merged = service.normalise({ receipt_file_id: 'file_1' }, {});

      expect(merged.receipt_file_id).toBe('file_1');
    });

    it('accepts a dispute that still needs a response', () => {
      expect(() => service.assertSubmittable(dispute())).not.toThrow();
    });

    it('refuses a dispute already under review', () => {
      expect(() => service.assertSubmittable(dispute({ status: 'under_review' }))).toThrow(
        DisputeWindowClosedException,
      );
    });

    it.each(['won', 'lost', 'warning_closed'])('refuses a %s dispute', (status) => {
      expect(() => service.assertSubmittable(dispute({ status }))).toThrow(DisputeWindowClosedException);
    });

    it('never exceeds 100', () => {
      const everything = Object.fromEntries(EVIDENCE_FIELDS.map((f) => [f, 'value']));

      expect(service.completeness(everything, 'product_not_received')).toBeLessThanOrEqual(100);
    });
  });

  describe('fieldCount and missingStrongFields', () => {
  });
});
