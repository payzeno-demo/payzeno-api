import { validateSync } from 'class-validator';

import {
  METADATA_MAX_KEYS,
  METADATA_MAX_VALUE_LENGTH,
  findMetadataViolation,
  IsPayzenoMetadata,
} from 'src/common/validators/metadata.validator';
import { Money } from 'src/common/validators/money.validator';
import { IsPayzenoId, IsVaultToken } from 'src/common/validators/payzeno-id.validator';
import {
  STATEMENT_DESCRIPTOR_MAX_LENGTH,
  composeStatementDescriptor,
  isValidStatementDescriptor,
  IsStatementDescriptor,
} from 'src/common/validators/statement-descriptor.validator';

import { TEST_CHARGE_ID, TEST_MERCHANT_ID } from 'test/factories/ids';

/**
 * The four custom class-validator constraints, exercised through real decorated classes
 * rather than by calling `validate()` on the constraint object — a constraint that is
 * correct but wired with the wrong `constraints` array fails in production and passes a
 * direct unit test.
 */

class AmountDto {
  @Money()
  amount_minor!: number;

  currency!: string;
}

class VoidableAmountDto {
  @Money({ allowZero: true })
  amount_minor!: number;

  currency!: string;
}

class RefundDto {
  @IsPayzenoId('ch_')
  charge_id!: string;
}

class AnyIdDto {
  @IsPayzenoId()
  id!: string;
}

class TokenDto {
  @IsVaultToken('pmt_')
  payment_method_token!: string;
}

class MetadataDto {
  @IsPayzenoMetadata()
  metadata!: unknown;
}

class DescriptorDto {
  @IsStatementDescriptor()
  statement_descriptor!: string;
}

function errorsOf(dto: object): string[] {
  return validateSync(dto).map((e) => e.property);
}

describe('@Money()', () => {
  function amount(value: unknown, currency = 'GBP'): AmountDto {
    return Object.assign(new AmountDto(), { amount_minor: value, currency });
  }

  it('accepts a positive integer', () => {
    expect(errorsOf(amount(4_500))).toEqual([]);
  });

  it('rejects a float — the single most common integration bug', () => {
    expect(errorsOf(amount(45.5))).toEqual(['amount_minor']);
  });

  it('rejects a negative amount', () => {
    expect(errorsOf(amount(-100))).toEqual(['amount_minor']);
  });

  it('rejects zero by default', () => {
    expect(errorsOf(amount(0))).toEqual(['amount_minor']);
  });

  it('accepts zero when the DTO opts in', () => {
    const dto = Object.assign(new VoidableAmountDto(), { amount_minor: 0, currency: 'GBP' });

    expect(errorsOf(dto)).toEqual([]);
  });

  it('rejects a string', () => {
    expect(errorsOf(amount('4500'))).toEqual(['amount_minor']);
  });

  it('accepts a JPY amount that would fail a hardcoded /100 assumption', () => {
    // JPY's exponent is 0. ¥5,000,000 is 5000000 minor units and perfectly ordinary.
    expect(errorsOf(amount(5_000_000, 'JPY'))).toEqual([]);
  });

  it('rejects an amount above the scheme ceiling', () => {
    expect(errorsOf(amount(Number.MAX_SAFE_INTEGER))).toEqual(['amount_minor']);
  });

  it('defers to the currency validator when the currency is itself invalid', () => {
    // Reporting two errors for one bad field buries the real one.
    expect(errorsOf(amount(4_500, 'CHF'))).toEqual([]);
  });

  it('names the currency in the message when it can', () => {
    const [error] = validateSync(amount(-1, 'GBP'));

    expect(Object.values(error.constraints ?? {}).join(' ')).toContain('GBP');
  });
});

describe('@IsPayzenoId()', () => {
  it('accepts an id with the required prefix', () => {
    expect(errorsOf(Object.assign(new RefundDto(), { charge_id: TEST_CHARGE_ID }))).toEqual([]);
  });

  it('rejects an id with the wrong prefix', () => {
    expect(errorsOf(Object.assign(new RefundDto(), { charge_id: TEST_MERCHANT_ID }))).toEqual([
      'charge_id',
    ]);
  });

  it('rejects a bare ULID with no prefix', () => {
    expect(
      errorsOf(Object.assign(new RefundDto(), { charge_id: TEST_CHARGE_ID.slice(3) })),
    ).toEqual(['charge_id']);
  });

  it('rejects a prefix with a malformed body', () => {
    expect(errorsOf(Object.assign(new RefundDto(), { charge_id: 'ch_123' }))).toEqual(['charge_id']);
  });

  it('rejects a SQL fragment', () => {
    expect(errorsOf(Object.assign(new RefundDto(), { charge_id: "ch_1' OR 1=1--" }))).toEqual([
      'charge_id',
    ]);
  });

  it('accepts any known prefix when none is required', () => {
    expect(errorsOf(Object.assign(new AnyIdDto(), { id: TEST_MERCHANT_ID }))).toEqual([]);
    expect(errorsOf(Object.assign(new AnyIdDto(), { id: TEST_CHARGE_ID }))).toEqual([]);
  });

  it('rejects a non-string', () => {
    expect(errorsOf(Object.assign(new RefundDto(), { charge_id: 42 }))).toEqual(['charge_id']);
  });
});

describe('@IsVaultToken()', () => {
  it('accepts a payment method token', () => {
    expect(
      errorsOf(Object.assign(new TokenDto(), { payment_method_token: 'pmt_9f2c41ab7d3e' })),
    ).toEqual([]);
  });

  it('rejects a bank account token in a card field', () => {
    // bat_ and pmt_ are both vault tokens and swapping them resolves the wrong instrument.
    expect(
      errorsOf(Object.assign(new TokenDto(), { payment_method_token: 'bat_9f2c41ab7d3e' })),
    ).toEqual(['payment_method_token']);
  });

  it('rejects a raw PAN in the token field', () => {
    expect(
      errorsOf(Object.assign(new TokenDto(), { payment_method_token: '4242424242424242' })),
    ).toEqual(['payment_method_token']);
  });
});

describe('@IsPayzenoMetadata()', () => {
  function metadata(value: unknown): MetadataDto {
    return Object.assign(new MetadataDto(), { metadata: value });
  }

  it('accepts a flat string map', () => {
    expect(errorsOf(metadata({ order_id: '4471', channel: 'web' }))).toEqual([]);
  });

  it('accepts an absent value', () => {
    expect(findMetadataViolation(undefined)).toBeNull();
    expect(findMetadataViolation(null)).toBeNull();
  });

  it('rejects an array', () => {
    expect(findMetadataViolation(['a', 'b'])).toBe('not_an_object');
  });

  it('rejects more than the key limit', () => {
    const many = Object.fromEntries(
      Array.from({ length: METADATA_MAX_KEYS + 1 }, (_, i) => [`k${i}`, 'v']),
    );

    expect(findMetadataViolation(many)).toBe('too_many_keys');
  });

  it('rejects a non-string value', () => {
    expect(findMetadataViolation({ amount: 4500 })).toBe('value_not_a_string');
  });

  it('rejects an over-long value', () => {
    expect(findMetadataViolation({ note: 'x'.repeat(METADATA_MAX_VALUE_LENGTH + 1) })).toBe(
      'value_too_long',
    );
  });

  it('rejects a PAN-shaped value — arc PCI', () => {
    // Merchants really do paste card numbers into `metadata.note`.
    expect(findMetadataViolation({ note: 'card 4242424242424242' })).toBe('value_looks_like_pan');
    expect(errorsOf(metadata({ note: '4242 4242 4242 4242' }))).toEqual(['metadata']);
  });

  it('does not reject an order reference that happens to be numeric', () => {
    expect(findMetadataViolation({ order_id: '447100221' })).toBeNull();
  });
});

describe('@IsStatementDescriptor()', () => {
  it('accepts a short alphanumeric descriptor', () => {
    expect(isValidStatementDescriptor('AURORA')).toBe(true);
    expect(errorsOf(Object.assign(new DescriptorDto(), { statement_descriptor: 'AURORA' }))).toEqual(
      [],
    );
  });

  it('rejects a descriptor over the card-network limit', () => {
    expect(isValidStatementDescriptor('X'.repeat(STATEMENT_DESCRIPTOR_MAX_LENGTH + 1))).toBe(false);
  });

  it('rejects an empty descriptor', () => {
    expect(isValidStatementDescriptor('')).toBe(false);
  });

  it('rejects characters the networks strip', () => {
    expect(isValidStatementDescriptor('AURORA <>')).toBe(false);
  });

  it('composes a base and a suffix within the limit', () => {
    const composed = composeStatementDescriptor('AURORA', 'ORD4471');

    expect(composed.length).toBeLessThanOrEqual(STATEMENT_DESCRIPTOR_MAX_LENGTH);
    expect(composed).toContain('AURORA');
  });

  it('returns the base unchanged when there is no suffix', () => {
    expect(composeStatementDescriptor('AURORA')).toBe('AURORA');
    expect(composeStatementDescriptor('AURORA', null)).toBe('AURORA');
  });
});
