import type { DataSource, SelectQueryBuilder } from 'typeorm';

import type { MerchantUserEntity } from 'src/merchants/users/merchant-user.entity';
import { MerchantUserRepository } from 'src/merchants/users/merchant-user.repository';

/**
 * `password_hash` is `select: false`. The login lookup is the one read that adds it back, and
 * it must name the PROPERTY: `addSelect('merchant_user.password_hash')` selects a raw column that
 * never reaches the entity, so `passwordHash` is undefined and every login fails the verify.
 */
describe('MerchantUserRepository', () => {
  function stubBuilder(): { builder: SelectQueryBuilder<MerchantUserEntity>; addSelect: jest.Mock } {
    const addSelect = jest.fn();
    const chain = {
      addSelect,
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    for (const step of [chain.addSelect, chain.where, chain.andWhere, chain.orderBy]) {
      step.mockReturnValue(chain);
    }
    return { builder: chain as unknown as SelectQueryBuilder<MerchantUserEntity>, addSelect };
  }

  it('selects the password hash by property path for the login lookup', async () => {
    // Regression: login could never succeed while the hash was not loaded onto the entity.
    const repository = new MerchantUserRepository({ createEntityManager: () => ({}) } as unknown as DataSource);
    const { builder, addSelect } = stubBuilder();
    jest.spyOn(repository, 'createQueryBuilder').mockReturnValue(builder);

    await repository.findLoginCandidates('owner@northwind.example');

    expect(addSelect).toHaveBeenCalledWith('merchant_user.passwordHash');
  });
});
