import type { Balance } from '@payzeno/contracts';

import { BalanceService } from 'src/ledger/balance.service';
import type { LedgerHttpClient } from 'src/ledger/ledger-http.client';
import { LedgerReadThroughService } from 'src/ledger/ledger-read-through.service';

function stub<T>(impl: Partial<T>): T {
  return impl as T;
}

function balance(currency: Balance['currency']): Balance {
  return stub<Balance>({ object: 'balance', merchant_id: 'mch_1', currency, available_minor: 100 });
}

/** RFC platform-v2 §7: balances are per currency, and `GET /v1/balance` lists them all. */
describe('BalanceService.list', () => {
  function service(answer: Balance | { data: Balance[] }): { balances: BalanceService; getBalance: jest.Mock } {
    const getBalance = jest.fn().mockResolvedValue(answer);
    const readThrough = new LedgerReadThroughService(stub<LedgerHttpClient>({ getBalance }));
    return { balances: new BalanceService(readThrough), getBalance };
  }

  it('asks the ledger without a currency and passes its per-currency list through', async () => {
    const { balances, getBalance } = service({ data: [balance('EUR'), balance('USD')] });

    const list = await balances.list('mch_1', true);

    expect(getBalance).toHaveBeenCalledWith('mch_1', { livemode: true });
    expect(list.data.map((b) => b.currency)).toEqual(['EUR', 'USD']);
  });

  it('reads a ledger that predates the list as a list of one', async () => {
    const { balances } = service(balance('USD'));
    expect((await balances.list('mch_1', false)).data).toEqual([balance('USD')]);
  });

  it('still reads one currency by name', async () => {
    const { balances, getBalance } = service(balance('JPY'));
    await balances.get('mch_1', 'JPY', true);
    expect(getBalance).toHaveBeenCalledWith('mch_1', { currency: 'JPY', livemode: true });
  });
});
