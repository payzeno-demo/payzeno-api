import type { AuthPrincipal } from '@payzeno/contracts';
import type { EntityManager } from 'typeorm';

import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import type { IdFactory } from 'src/common/ids/id.factory';
import { NoopLogger } from 'src/common/logging/logger';
import type { TransactionManager } from 'src/common/persistence/transaction.manager';
import { CustomerEntity } from 'src/customers/customer.entity';
import type { CustomerPatch, CustomerRepository } from 'src/customers/customer.repository';
import { CustomersService } from 'src/customers/customers.service';
import { PaymentMethodEntity } from 'src/payment-methods/payment-method.entity';
import type { PaymentMethodsService } from 'src/payment-methods/payment-methods.service';
import { FixedClock } from 'test/support/fixed-clock';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

const PRINCIPAL: AuthPrincipal = { kind: 'api_key', merchant_id: 'mch_1', api_key_id: 'key_1', mode: 'test', scopes: [] };

describe('CustomersService', () => {
  let row: CustomerEntity;
  let inserted: CustomerEntity[];
  let patches: CustomerPatch[];
  let getUsable: jest.Mock;
  let cleared: string[];
  let forgotten: string[];

  function service(): CustomersService {
    return new CustomersService(
      stub<CustomerRepository>({
        findScoped: jest.fn(async (id: string) => (id === row.id ? row : null)),
        insertCustomer: jest.fn(async (customer: CustomerEntity) => {
          inserted.push(customer);
          return customer;
        }),
        patch: jest.fn(async (_scope, _id: string, patch: CustomerPatch) => {
          patches.push(patch);
          return 1;
        }),
        clearDefaultPaymentMethod: jest.fn(async (_m: EntityManager, id: string) => {
          cleared.push(id);
        }),
      }),
      stub<PaymentMethodsService>({
        getUsable,
        detach: jest.fn(async () => card()),
        forgetToken: jest.fn(async (pm: PaymentMethodEntity) => {
          forgotten.push(pm.vaultToken);
        }),
        list: jest.fn(async () => [card()]),
      }),
      stub<TransactionManager>({ runInTransaction: jest.fn(async <T>(fn: (m: EntityManager) => Promise<T>) => fn(stub<EntityManager>({}))) }),
      stub<IdFactory>({ opaque: (prefix: string) => `${prefix}01JBCUSTOMER000000000000AA` }),
      new FixedClock('2026-10-29T09:00:00.000Z'),
      new NoopLogger(),
    );
  }

  beforeEach(() => {
    row = Object.assign(new CustomerEntity(), {
      id: 'cus_1',
      merchantId: 'mch_1',
      livemode: false,
      email: 'shopper@example.com',
      name: null,
      defaultPaymentMethodId: null,
      metadata: {},
      createdAt: new Date('2026-10-29T08:00:00.000Z'),
      updatedAt: new Date('2026-10-29T08:00:00.000Z'),
    });
    inserted = [];
    patches = [];
    cleared = [];
    forgotten = [];
    getUsable = jest.fn(async () => card());
  });

  it('creates a customer in the key’s scope', async () => {
    const customer = await service().create(PRINCIPAL, { email: 'new@example.com', name: 'Ada' });

    expect(customer).toMatchObject({
      id: 'cus_01JBCUSTOMER000000000000AA',
      object: 'customer',
      merchant_id: 'mch_1',
      email: 'new@example.com',
      livemode: false,
      default_payment_method_id: null,
    });
    expect(inserted[0].livemode).toBe(false);
  });

  it('sets the default card only to one of the customer’s own attached cards', async () => {
    const updated = await service().update(PRINCIPAL, 'cus_1', { default_payment_method_id: 'pm_1' });

    expect(getUsable).toHaveBeenCalledWith({ merchantId: 'mch_1', livemode: false }, 'cus_1', 'pm_1');
    expect(patches).toEqual([{ defaultPaymentMethodId: 'pm_1' }]);
    expect(updated.default_payment_method_id).toBe('pm_1');
  });

  it('answers 404 for another customer’s card', async () => {
    getUsable.mockRejectedValue(new ResourceNotFoundException('payment_method', 'pm_other'));
    await expect(service().update(PRINCIPAL, 'cus_1', { default_payment_method_id: 'pm_other' })).rejects.toBeInstanceOf(
      ResourceNotFoundException,
    );
    expect(patches).toHaveLength(0);
  });

  it('answers 404 for a customer of another tenant or mode', async () => {
    await expect(service().get(PRINCIPAL, 'cus_elsewhere')).rejects.toBeInstanceOf(ResourceNotFoundException);
  });

  it('lists saved cards without their vault token', async () => {
    const page = await service().listPaymentMethods(PRINCIPAL, 'cus_1');
    expect(page.data[0]).toMatchObject({ id: 'pm_1', object: 'payment_method', card: { last_four: '4242' } });
    expect(JSON.stringify(page)).not.toContain('pmt_');
  });

  it('detaching a card clears it as the default and forgets it at the vault', async () => {
    const detached = await service().detachPaymentMethod(PRINCIPAL, 'cus_1', 'pm_1');
    expect(detached.id).toBe('pm_1');
    expect(cleared).toEqual(['pm_1']);
    expect(forgotten).toEqual(['pmt_reusable']);
  });
});

function card(): PaymentMethodEntity {
  return Object.assign(new PaymentMethodEntity(), {
    id: 'pm_1',
    customerId: 'cus_1',
    livemode: false,
    vaultToken: 'pmt_reusable',
    fingerprint: 'fp_1',
    cardBrand: 'visa',
    cardLastFour: '4242',
    cardExpMonth: 12,
    cardExpYear: 2030,
    cardCountry: 'US',
    cardFunding: 'credit',
    detachedAt: null,
    createdAt: new Date('2026-10-29T08:00:00.000Z'),
  });
}
