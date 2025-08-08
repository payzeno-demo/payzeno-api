/**
 * `@IsStatementDescriptor()` — ≤ 22 chars, `[A-Za-z0-9 .,\-]` only (domain-model.md §11.4).
 *
 * The constraint is the card schemes', not ours: the descriptor is what the cardholder sees
 * on their statement, and a character outside this set is silently mangled or truncated by
 * the issuer — which produces a "I don't recognise this charge" dispute, which costs the
 * merchant a dispute fee. That is why it is a hard 422 and not a normalisation.
 */
import {
  registerDecorator,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidationOptions,
  type ValidatorConstraintInterface,
} from 'class-validator';

export const STATEMENT_DESCRIPTOR_MAX_LENGTH = 22;
const ALLOWED = /^[A-Za-z0-9 .,-]+$/;
/** At least five non-space characters, or the statement line is useless to the cardholder. */
const MIN_SIGNIFICANT = 5;

export function isValidStatementDescriptor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > STATEMENT_DESCRIPTOR_MAX_LENGTH) return false;
  if (!ALLOWED.test(trimmed)) return false;
  return trimmed.replace(/\s/g, '').length >= MIN_SIGNIFICANT;
}

/** Merchant default + per-charge suffix, clamped. Used by ChargeAuthorizationService. */
export function composeStatementDescriptor(base: string, suffix?: string | null): string {
  const merged = suffix ? `${base.trim()}* ${suffix.trim()}` : base.trim();
  return merged.slice(0, STATEMENT_DESCRIPTOR_MAX_LENGTH).trim();
}

@ValidatorConstraint({ name: 'IsStatementDescriptor', async: false })
export class StatementDescriptorConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value === undefined || value === null || isValidStatementDescriptor(value);
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be ${MIN_SIGNIFICANT}-${STATEMENT_DESCRIPTOR_MAX_LENGTH} characters of letters, digits, spaces, periods, commas or hyphens`;
  }
}

export function IsStatementDescriptor(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'IsStatementDescriptor',
      target: object.constructor,
      propertyName: propertyName as string,
      constraints: [],
      options: validationOptions,
      validator: StatementDescriptorConstraint,
    });
  };
}
