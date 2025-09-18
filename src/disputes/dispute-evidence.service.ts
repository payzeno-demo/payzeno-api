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
    const strong = STRONG_FIELDS_BY_REASON[reason] ?? STRONG_FIELDS_BY_REASON.general;
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
  }
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
