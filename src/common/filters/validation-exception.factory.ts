/**
 * Turns class-validator output into a `ValidationException` carrying `FieldError[]`.
 *
 * Registered on the global ValidationPipe in main.ts. Two things it does that the default
 * factory does not:
 *
 *   1. builds the DOTTED path (`payment_method.exp_month`), because a flat property name is
 *      useless on a nested DTO and the console renders errors against the form path;
 *   2. redacts the path through `redactPath` — arc PCI. `field_errors[].path` was one of the
 *      four surfaces raw bank details reached (domain-model.md §11.2). A validation error on
 *      `account_number` must not name the field next to the value that failed.
 */
import type { ValidationError } from 'class-validator';

import type { FieldError } from '@payzeno/contracts';

import { ValidationException } from '../errors/api.exception';
import { redactPath } from '../redaction/redaction.denylist';

export function toFieldErrors(errors: readonly ValidationError[], parentPath = ''): FieldError[] {
  const out: FieldError[] = [];

  for (const error of errors) {
    const path = parentPath ? `${parentPath}.${error.property}` : error.property;

    for (const [code, message] of Object.entries(error.constraints ?? {})) {
      out.push({ path: redactPath(path), code, message });
    }

    if (error.children && error.children.length > 0) {
      out.push(...toFieldErrors(error.children, path));
    }
  }

  return out;
}

/** The function handed to `new ValidationPipe({ exceptionFactory })`. */
export function validationExceptionFactory(errors: ValidationError[]): ValidationException {
  const fieldErrors = toFieldErrors(errors);

  return new ValidationException(
    fieldErrors.length === 1
      ? `Invalid value for '${fieldErrors[0].path}'`
      : `Request failed validation on ${fieldErrors.length} fields`,
    fieldErrors,
  );
}
