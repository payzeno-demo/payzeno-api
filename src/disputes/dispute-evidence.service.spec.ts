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

    it('trims whitespace', () => {
      expect(service.normalise({}, { customer_name: '  A. Customer  ' })).toEqual({
        customer_name: 'A. Customer',
      });
    });

    it('an explicitly emptied field is a deletion', () => {
      const merged = service.normalise({ customer_name: 'A. Customer' }, { customer_name: '   ' });

      expect(merged.customer_name).toBeUndefined();
    });

    it('leaves untouched fields alone', () => {
      const merged = service.normalise({ receipt_file_id: 'file_1' }, {});

      expect(merged.receipt_file_id).toBe('file_1');
    });

    it('rejects a field past the network length limit', () => {
      expect(() => service.normalise({}, { uncategorized_text: 'x'.repeat(20_001) })).toThrow(
        ValidationException,
      );
    });
  });

  describe('assertSubmittable', () => {
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

    it('refuses evidence after the deadline', () => {
      clock.advanceDays(30);

      expect(() => service.assertSubmittable(dispute())).toThrow(DisputeWindowClosedException);
    });

    it('accepts evidence on the last day', () => {
      clock.advanceDays(16);

      expect(() => service.assertSubmittable(dispute())).not.toThrow();
    });
  });

  describe('completeness', () => {
    it('is zero for empty evidence', () => {
      expect(service.completeness({}, 'fraudulent')).toBe(0);
    });

    it('rewards the fields that matter for the reason code', () => {
      const strong = service.completeness(
        { customer_name: 'A', customer_email: 'a@example.com', shipping_tracking_number: 'T' },
        'fraudulent',
      );
      const weak = service.completeness(
        { product_description: 'A thing', uncategorized_text: 'please' },
        'fraudulent',
      );

      expect(strong).toBeGreaterThan(weak);
    });

    it('never exceeds 100', () => {
      const everything = Object.fromEntries(EVIDENCE_FIELDS.map((f) => [f, 'value']));

      expect(service.completeness(everything, 'product_not_received')).toBeLessThanOrEqual(100);
    });
  });

  describe('fieldCount and missingStrongFields', () => {
    it('counts only fields with content', () => {
      expect(service.fieldCount({ customer_name: 'A', customer_email: '  ' })).toBe(1);
    });

    it('names what is still worth chasing', () => {
      const missing = service.missingStrongFields({ shipping_tracking_number: 'T' }, 'product_not_received');

      expect(missing).toContain('receipt_file_id');
      expect(missing).not.toContain('shipping_tracking_number');
    });

    it('falls back to the general reason for a code it does not know', () => {
      expect(service.missingStrongFields({}, 'not_a_real_reason')).toEqual(['uncategorized_text']);
    });
  });
});
