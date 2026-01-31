/**
 * `@IsPayzenoMetadata()` — the `metadata` JSONB constraint. arc PCI.
 *
 * Bounds (domain-model.md §2): ≤ 20 keys, ≤ 40 chars per key, ≤ 500 chars per value, string
 * values only.
 *
 * And the reason this file is in the PCI arc rather than the validation one: **it rejects
 * PAN-shaped values**. `metadata` is the field merchants use as a scratchpad, and a
 * free-form string bag that survives into `charge.metadata`, into every webhook payload and
 * into the console's rendered detail view is exactly where a card number ends up if nothing
 * looks. docs/compliance/pci-scope.md cites this constraint.
 */
import {
  registerDecorator,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidationOptions,
  type ValidatorConstraintInterface,
} from 'class-validator';

import { containsPan } from '../redaction/pan.matcher';

export const METADATA_MAX_KEYS = 20;
export const METADATA_MAX_VALUE_LENGTH = 500;

export type MetadataViolation =
  | 'not_an_object'
  | 'too_many_keys'
  | 'key_too_long'
  | 'value_not_a_string'
  | 'value_too_long'
  | 'value_looks_like_pan';

/** Returns the first violation, or null. Exported so services can validate non-DTO metadata. */
export function findMetadataViolation(value: unknown): MetadataViolation | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'not_an_object';

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > METADATA_MAX_KEYS) return 'too_many_keys';

  for (const [key, item] of entries) {
    if (key.length > METADATA_MAX_KEY_LENGTH) return 'key_too_long';
    if (typeof item !== 'string') return 'value_not_a_string';
    if (item.length > METADATA_MAX_VALUE_LENGTH) return 'value_too_long';
    if (containsPan(item)) return 'value_looks_like_pan';
  }

  return null;
}

