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

