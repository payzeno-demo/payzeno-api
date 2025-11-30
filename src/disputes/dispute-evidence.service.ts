/**
 * DisputeEvidenceService — L5. Everything about the evidence blob except storing it.
 *
 * Three jobs:
 *   - normalise what the merchant sent (trim, drop empties, cap length);
 *   - refuse evidence the network will not accept (past the deadline, wrong lifecycle);
 *   - score completeness, which is what the console's progress bar reads and what the
 *     `dispute.evidence_submitted` event carries as `evidence_field_count`.
 *
 * What it deliberately does NOT do is talk to the acquirer. Evidence goes to the network
 * through the acquirer's own portal upload (PAY-1440 tracks the API version of that), so
 * `submitted_at` here means "we accepted it and it is queued", not "the network has it".
 * Saying otherwise in the console cost support two weeks of arguments in month 6.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DisputeEvidence } from '@payzeno/contracts';

import { DisputeWindowClosedException } from '../common/errors/business.exceptions';
import { ValidationException } from '../common/errors/api.exception';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';
import { DisputeEntity } from './dispute.entity';

/** Order matters: it is the order the console renders the checklist in. */
export const EVIDENCE_FIELDS = [
  'product_description',
  'customer_name',
  'customer_email',
  'shipping_tracking_number',
  'receipt_file_id',
  'service_documentation_file_id',
  'uncategorized_text',
] as const;

export type EvidenceField = (typeof EVIDENCE_FIELDS)[number];

/** Networks truncate; better we do it visibly than they do it silently. */
const MAX_FIELD_LENGTH = 20_000;

/** Which fields actually move the needle, per reason code. Used for the console's hints. */
const STRONG_FIELDS_BY_REASON: Readonly<Record<string, ReadonlyArray<EvidenceField>>> = {
  fraudulent: ['customer_name', 'customer_email', 'shipping_tracking_number'],
  product_not_received: ['shipping_tracking_number', 'receipt_file_id'],
  product_unacceptable: ['product_description', 'service_documentation_file_id'],
  duplicate: ['receipt_file_id', 'uncategorized_text'],
  subscription_canceled: ['service_documentation_file_id', 'uncategorized_text'],
  credit_not_processed: ['receipt_file_id'],
  general: ['uncategorized_text'],
};

@Injectable()
export class DisputeEvidenceService {
  constructor(
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  /**
   * Merges the submitted fields over whatever was staged before. Merging, not replacing: the
   * console saves each section as the merchant fills it, and a PATCH-shaped body that replaced
   * the blob would delete the sections they filled yesterday.
   */
  normalise(existing: DisputeEvidence, incoming: DisputeEvidence): DisputeEvidence {
    const merged: DisputeEvidence = { ...existing };

    for (const field of EVIDENCE_FIELDS) {
      const value = incoming[field];
      if (value === undefined) continue;

      const trimmed = String(value).trim();
      if (trimmed.length === 0) {
        delete merged[field];
        continue;
      }
      if (trimmed.length > MAX_FIELD_LENGTH) {
        throw new ValidationException(`evidence.${field} exceeds ${MAX_FIELD_LENGTH} characters`, [
          {
            path: `evidence.${field}`,
            code: 'too_long',
            message: `must be at most ${MAX_FIELD_LENGTH} characters`,
          },
        ]);
      }
      merged[field] = trimmed;
    }

    return merged;
  }

  /**
   * Refuses a submission the network will reject anyway. Throwing here rather than at the
   * acquirer means the merchant gets a 422 with a due date instead of a 502 three days later.
   */
  assertSubmittable(dispute: DisputeEntity): void {
    if (dispute.status !== 'needs_response') {
      throw new DisputeWindowClosedException(
        dispute.id,
        dispute.evidence_due_by ? dispute.evidence_due_by.toISOString() : null,
      );
    }

    if (dispute.evidence_due_by && dispute.evidence_due_by.getTime() < this.clock.nowMs()) {
      // DisputeDeadlineReminderJob will move it to `lost` on its next pass; we do not do it
      // here, because that transition emits `dispute.closed` and one emitter is enough.
      this.logger.info('dispute_evidence_after_deadline', {
        dispute_id: dispute.id,
        evidence_due_by: dispute.evidence_due_by.toISOString(),
      });
      throw new DisputeWindowClosedException(dispute.id, dispute.evidence_due_by.toISOString());
    }
  }

  /** 0-100. The console shows it as a progress bar; nothing branches on it. */
  completeness(evidence: DisputeEvidence, reason: string): number {
    const strong = STRONG_FIELDS_BY_REASON[reason] ?? STRONG_FIELDS_BY_REASON.general;
    const filled = EVIDENCE_FIELDS.filter((field) => hasValue(evidence[field]));
    if (filled.length === 0) return 0;

    const strongFilled = strong.filter((field) => hasValue(evidence[field])).length;
    const base = (filled.length / EVIDENCE_FIELDS.length) * 60;
    const bonus = strong.length === 0 ? 40 : (strongFilled / strong.length) * 40;

    return Math.round(base + bonus);
  }

  fieldCount(evidence: DisputeEvidence): number {
    return EVIDENCE_FIELDS.filter((field) => hasValue(evidence[field])).length;
  }

  /** The fields worth chasing for this reason code, minus the ones already there. */
  missingStrongFields(evidence: DisputeEvidence, reason: string): EvidenceField[] {
    const strong = STRONG_FIELDS_BY_REASON[reason] ?? STRONG_FIELDS_BY_REASON.general;
    return strong.filter((field) => !hasValue(evidence[field]));
  }
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
