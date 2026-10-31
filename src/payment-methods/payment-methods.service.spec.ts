import type { EntityManager } from 'typeorm';

import { ValidationException } from 'src/common/errors/api.exception';
import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import type { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import { PaymentMethodEntity } from 'src/payment-methods/payment-method.entity';
import type { PaymentMethodRepository } from 'src/payment-methods/payment-method.repository';
import { PaymentMethodsService } from 'src/payment-methods/payment-methods.service';
import type { VaultClient } from 'src/payments/vault/vault.client';
import type { TokenResolution } from 'src/payments/vault/vault.types';
import { FixedClock } from 'test/support/fixed-clock';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

const MANAGER = stub<EntityManager>({});
const SCOPE = { merchantId: 'mch_1', livemode: true };
const RESOLUTION: TokenResolution = {
  token: 'pmt_01JBTOKEN000000000000000AA',
  fingerprint: 'fp_4242',
  card: { brand: 'visa', last_four: '4242', exp_month: 12, exp_year: 2030, country: 'US', funding: 'credit' },
};

describe('PaymentMethodsService', () => {
  let existing: PaymentMethodEntity | null;
  let inserted: PaymentMethodEntity[];
  let resolve: jest.Mock;

  function service(): PaymentMethodsService {
    return new PaymentMethodsService(
      stub<PaymentMethodRepository>({
        findAttachedByFingerprint: jest.fn(async () => existing),
        insertPaymentMethod: jest.fn(async (_m: EntityManager, row: PaymentMethodEntity) => {
          inserted.push(row);
          return row;
        }),
        findAttached: jest.fn(async () => existing),
      }),
      stub<VaultClient>({ resolve }),
      stub<IdFactory>({ opaque: (prefix: string) => `${prefix}01JBPM00000000000000000AAA` }),
      new FixedClock('2026-10-29T09:00:00.000Z'),
      new NoopLogger(),
    );
  }

  beforeEach(() => {
    existing = null;
    inserted = [];
    resolve = jest.fn().mockResolvedValue(RESOLUTION);
  });

  it('saves the resolved card with its reusable token and fingerprint', async () => {
    const saved = await service().attach(MANAGER, SCOPE, 'cus_1', RESOLUTION);

    expect(saved).toMatchObject({
      id: 'pm_01JBPM00000000000000000AAA',
      customerId: 'cus_1',
      vaultToken: 'pmt_01JBTOKEN000000000000000AA',
      fingerprint: 'fp_4242',
      cardLastFour: '4242',
      cardCountry: 'US',
      livemode: true,
    });
  });

  it('is idempotent per customer: the same card saved twice is one row', async () => {
    existing = Object.assign(new PaymentMethodEntity(), { id: 'pm_existing', customerId: 'cus_1' });
    const saved = await service().attach(MANAGER, SCOPE, 'cus_1', RESOLUTION);

    expect(saved.id).toBe('pm_existing');
    expect(inserted).toHaveLength(0);
  });

  it('refuses a token that is not a card token before asking the vault', () => {
    expect(() => service().resolve('bat_01JB')).toThrow(ValidationException);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('treats another customer’s card as not found', async () => {
    existing = Object.assign(new PaymentMethodEntity(), { id: 'pm_1', customerId: 'cus_2' });
    await expect(service().getUsable(SCOPE, 'cus_1', 'pm_1')).rejects.toBeInstanceOf(ResourceNotFoundException);
  });
});
