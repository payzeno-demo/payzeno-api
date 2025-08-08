/**
 * `@Money()` — the class-validator constraint on every `*_minor` field. ~60 sites.
 *
 * Rejects: non-integers (a float amount is the single most common integration bug), zero and
 * negatives, and anything above the scheme ceiling. It does NOT know the currency — the DTO
 * carries `currency` as a sibling field, so the constraint reads it off the object and
 * applies the right exponent-aware bounds. JPY's exponent is 0 and a "divide by 100"
 * assumption here would reject every legitimate yen amount over ¥999,999.
 */
import {
  registerDecorator,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidationOptions,
  type ValidatorConstraintInterface,
} from 'class-validator';

import { CURRENCIES, type CurrencyCode } from '@payzeno/contracts';

import { maximumChargeableMinor, minimumChargeableMinor } from '../money/money.util';

export interface MoneyOptions {
  /** Sibling field holding the currency. Default `currency`. */
  currencyField?: string;
  /** Permit zero — used by `CapturePaymentIntentRequest.amount_minor` on a full void. */
  allowZero?: boolean;
  /** Skip the scheme ceiling; only the internal adjustment routes set this. */
  skipCeiling?: boolean;
}

@ValidatorConstraint({ name: 'Money', async: false })
export class MoneyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const options = (args.constraints[0] ?? {}) as MoneyOptions;

    if (typeof value !== 'number' || !Number.isInteger(value)) return false;
    if (value < 0) return false;
    if (value === 0 && !options.allowZero) return false;

    const currency = this.currencyOf(args, options);
    if (!currency) return true; // currency itself is invalid; its own validator reports that

    if (value !== 0 && value < minimumChargeableMinor(currency)) return false;
    if (!options.skipCeiling && value > maximumChargeableMinor(currency)) return false;

    return true;
  }

  defaultMessage(args: ValidationArguments): string {
    const options = (args.constraints[0] ?? {}) as MoneyOptions;
    const currency = this.currencyOf(args, options);
    return currency
      ? `${args.property} must be a positive integer in ${currency} minor units`
      : `${args.property} must be a positive integer amount in minor units`;
  }

  private currencyOf(args: ValidationArguments, options: MoneyOptions): CurrencyCode | null {
    const field = options.currencyField ?? 'currency';
    const raw = (args.object as Record<string, unknown>)[field];
    if (typeof raw !== 'string') return null;
    const upper = raw.trim().toUpperCase();
    return (CURRENCIES as readonly string[]).includes(upper) ? (upper as CurrencyCode) : null;
  }
}

export function Money(options: MoneyOptions = {}, validationOptions?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'Money',
      target: object.constructor,
      propertyName: propertyName as string,
      constraints: [options],
      options: validationOptions,
      validator: MoneyConstraint,
    });
  };
}
