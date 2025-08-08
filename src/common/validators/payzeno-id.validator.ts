/**
 * `@IsPayzenoId('ch_')` — prefixed-ULID validation on every id field of every DTO.
 *
 * Catching a wrong-prefix id at the edge is worth a decorator: `charge_id: 'pi_01H…'` on a
 * refund otherwise becomes a scoped repository miss and a 404, and the merchant spends an
 * afternoon convinced their charge does not exist.
 */
import {
  registerDecorator,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidationOptions,
  type ValidatorConstraintInterface,
} from 'class-validator';

import { isPayzenoId } from '../ids/id.prefix';

@ValidatorConstraint({ name: 'IsPayzenoId', async: false })
export class PayzenoIdConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const prefix = args.constraints[0] as string | undefined;
    return isPayzenoId(value, prefix);
  }

  defaultMessage(args: ValidationArguments): string {
    const prefix = args.constraints[0] as string | undefined;
    return prefix
      ? `${args.property} must be a Payzeno id beginning '${prefix}'`
      : `${args.property} must be a Payzeno id`;
  }
}

export function IsPayzenoId(prefix?: string, validationOptions?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'IsPayzenoId',
      target: object.constructor,
      propertyName: propertyName as string,
      constraints: [prefix],
      options: validationOptions,
      validator: PayzenoIdConstraint,
    });
  };
}

/** Vault tokens are not Payzeno ids — different alphabet, different owner. */
@ValidatorConstraint({ name: 'IsVaultToken', async: false })
export class VaultTokenConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const prefix = (args.constraints[0] as string) ?? 'pmt_';
    return typeof value === 'string' && value.startsWith(prefix) && value.length >= prefix.length + 16;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be a vault token beginning '${args.constraints[0] ?? 'pmt_'}'`;
  }
}

export function IsVaultToken(prefix: 'pmt_' | 'bat_' = 'pmt_', validationOptions?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'IsVaultToken',
      target: object.constructor,
      propertyName: propertyName as string,
      constraints: [prefix],
      options: validationOptions,
      validator: VaultTokenConstraint,
    });
  };
}
