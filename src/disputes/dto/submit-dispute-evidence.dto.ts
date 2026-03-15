/**
 * `POST /v1/disputes/:disputeId/evidence` body.
 *
 * `implements SubmitDisputeEvidenceRequest`. The nested evidence object gets its own class so
 * `ValidationPipe` walks into it — a bare `@IsObject()` would accept
 * `{"evidence": {"customer_email": 4111111111111111}}`, which is a PAN in a text field, which
 * is the one thing arc PCI exists to stop.
 */

import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
  registerDecorator,
  type ValidationOptions,
} from 'class-validator';

import type { DisputeEvidence, SubmitDisputeEvidenceRequest } from '@payzeno/contracts';

import { Redact } from '../../common/decorators/redact.decorator';
import { containsPan } from '../../common/redaction/pan.matcher';

const FREE_TEXT_MAX = 20_000;

/**
 * Free-text evidence is the one merchant-supplied field wide enough to hold a PAN, and three
 * merchants pasted one into it in month 4. Rejected with a message that does not echo the
 * value back — arc PCI, docs/compliance/pci-scope.md.
 */
function NoPanValues(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'NoPanValues',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value !== 'string' || !containsPan(value);
        },
        defaultMessage(): string {
          return 'must not contain card numbers';
        },
      },
    });
  };
}

export class DisputeEvidenceDto implements DisputeEvidence {
  @IsOptional()
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  @NoPanValues()
  product_description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  customer_name?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  customer_email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  shipping_tracking_number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  receipt_file_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  service_documentation_file_id?: string;

  /**
   * The field merchants paste everything into, including — three times in month 4 — a full
   * card number. `@NoPanValues()` runs the Luhn matcher over it and rejects with a 422 whose
   * message does not echo the value back.
   */
  @IsOptional()
  @IsString()
  @MaxLength(FREE_TEXT_MAX)
  @NoPanValues()
  uncategorized_text?: string;
}

@Redact('evidence.uncategorized_text', 'evidence.customer_email')
export class SubmitDisputeEvidenceDto implements SubmitDisputeEvidenceRequest {
  @ValidateNested()
  @Type(() => DisputeEvidenceDto)
  evidence: DisputeEvidenceDto;

  /** False stages the evidence without sending it — the console autosaves with `false`. */
  @IsOptional()
  @IsBoolean()
  submit?: boolean;
}
