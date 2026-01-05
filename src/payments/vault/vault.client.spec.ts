import { DEFAULT_CLIENT_OPTIONS } from 'src/api/client';
import { InMemoryTransport } from 'src/api/in-memory-transport';
import { IdempotentRetryPolicy } from 'src/api/retry.policy';
import { TransportError } from 'src/api/transport.interface';
import { ResourceNotFoundException } from 'src/common/errors/not-found.exceptions';
import { UpstreamException } from 'src/common/errors/upstream.exceptions';
import { ValidationException } from 'src/common/errors/api.exception';
import { NoopLogger } from 'src/common/logging/logger';
import { VaultClient } from 'src/payments/vault/vault.client';

/**
 * arc PCI lives here. `resolve()` is the only vault call the normal flow makes;
 * `tokenise()` is the server-side MOTO path the arc exists to remove — still reachable,
 * still staff-gated, and it must log `SERVER_SIDE_TOKENISATION` at WARN on every call,
 * because that log line is the metric the compliance ticket tracks.
 */
describe('VaultClient', () => {
  let transport: InMemoryTransport;
  let logger: NoopLogger;
  let client: VaultClient;

  beforeEach(() => {
    transport = new InMemoryTransport();
    logger = new NoopLogger();
    jest.spyOn(logger, 'warn');
    client = new VaultClient(
      { baseUrl: 'http://vault.test', apiKey: 'vault_test_key' },
      transport,
      DEFAULT_CLIENT_OPTIONS,
      new IdempotentRetryPolicy(2),
      logger,
    );
  });

  const resolution = {
    token: 'pmt_visa_4242',
    card: {
      brand: 'visa',
      last_four: '4242',
      exp_month: 11,
      exp_year: 2029,
      country: 'GB',
      funding: 'credit',
    },
    fingerprint: 'fp_9f2c41ab',
  };

  describe('resolve', () => {
    it('POSTs /tokens/resolve and returns the card summary plus fingerprint', async () => {
      transport.on('POST', '/tokens/resolve', () => ({ status: 200, body: resolution }));

      const result = await client.resolve('pmt_visa_4242');

      expect(transport.callsTo('POST', '/tokens/resolve')).toHaveLength(1);
      expect(result.card.last_four).toBe('4242');
      expect(result.fingerprint).toBe('fp_9f2c41ab');
    });

    it('sends the bearer credential the vault expects', async () => {
      transport.on('POST', '/tokens/resolve', () => ({ status: 200, body: resolution }));

      await client.resolve('pmt_visa_4242');

      expect(transport.callsTo('POST', '/tokens/resolve')[0].headers.authorization).toBe(
        'Bearer vault_test_key',
      );
    });

    it('never puts the token in the URL', async () => {
      transport.on('POST', '/tokens/resolve', () => ({ status: 200, body: resolution }));

      await client.resolve('pmt_visa_4242');

      const [call] = transport.callsTo('POST', '/tokens/resolve');
      expect(call.url).not.toContain('pmt_visa_4242');
      expect(call.body).toMatchObject({ token: 'pmt_visa_4242' });
    });

    it('throws ResourceNotFoundException for an unknown token', async () => {
      transport.on('POST', '/tokens/resolve', () => ({
        status: 404,
        body: { code: 'token_not_found', message: 'unknown token' },
      }));

      await expect(client.resolve('pmt_nope')).rejects.toBeInstanceOf(ResourceNotFoundException);
    });

    it('throws ValidationException for a malformed token', async () => {
      transport.on('POST', '/tokens/resolve', () => ({
        status: 422,
        body: { code: 'invalid_token', message: 'token is not a payment method token' },
      }));

      await expect(client.resolve('bat_bank_account')).rejects.toBeInstanceOf(ValidationException);
    });

    it('throws an UpstreamException when the vault is unreachable', async () => {
      transport.on('POST', '/tokens/resolve', () => ({ status: 200, body: resolution }));
      transport.failOnce(
        new TransportError('network', 'http://vault.test/tokens/resolve', 'ECONNREFUSED'),
      );

      await expect(client.resolve('pmt_visa_4242')).rejects.toBeInstanceOf(UpstreamException);
    });
  });

  describe('delete', () => {
    it('DELETEs /tokens/{token} on account closure', async () => {
      transport.on('DELETE', '/tokens/:token', () => ({ status: 200, body: { deleted: true } }));

      await expect(client.delete('pmt_visa_4242')).resolves.toBe(true);
      expect(transport.callsTo('DELETE', '/tokens/:token')[0].path).toBe('/tokens/pmt_visa_4242');
    });

    it('url-encodes the token rather than interpolating it raw', async () => {
      transport.on('DELETE', /^\/tokens\/.+$/, () => ({ status: 200, body: { deleted: true } }));

      await client.delete('pmt/with slash');

      const [call] = transport.callsTo('DELETE', /^\/tokens\//);
      expect(call.path).not.toContain(' ');
    });
  });

  describe('tokenise (legacy MOTO — arc PCI)', () => {
    const request = {
      pan: '378282246310005',
      exp_month: 3,
      exp_year: 2027,
      cvv: '1234',
      cardholder_name: 'A Cardholder',
    };

    it('POSTs /tokens and returns the new token', async () => {
      transport.on('POST', '/tokens', () => ({
        status: 201,
        body: { token: 'pmt_moto_0001', fingerprint: 'fp_moto' },
      }));

      const result = await client.tokenise(request, 'stf_support_04');

      expect(result.token).toBe('pmt_moto_0001');
    });

    it('logs SERVER_SIDE_TOKENISATION at WARN on every call, with the staff id', async () => {
      transport.on('POST', '/tokens', () => ({
        status: 201,
        body: { token: 'pmt_moto_0002', fingerprint: 'fp_moto' },
      }));

      await client.tokenise(request, 'stf_support_04');

      expect(logger.warn).toHaveBeenCalledWith(
        'SERVER_SIDE_TOKENISATION',
        expect.objectContaining({ staff_id: 'stf_support_04' }),
      );
    });

    it('never puts the PAN or the CVV into the log context', async () => {
      transport.on('POST', '/tokens', () => ({
        status: 201,
        body: { token: 'pmt_moto_0003', fingerprint: 'fp_moto' },
      }));

      await client.tokenise(request, 'stf_support_04');

      const logged = JSON.stringify((logger.warn as jest.Mock).mock.calls);
      expect(logged).not.toContain('378282246310005');
      expect(logged).not.toContain('1234');
    });

    it('logs even when the vault then rejects the card', async () => {
      transport.on('POST', '/tokens', () => ({
        status: 422,
        body: { code: 'invalid_card', message: 'luhn check failed' },
      }));

      await expect(client.tokenise(request, 'stf_support_04')).rejects.toBeInstanceOf(
        ValidationException,
      );
      // The compliance metric counts attempts, not successes.
      expect(logger.warn).toHaveBeenCalledWith('SERVER_SIDE_TOKENISATION', expect.anything());
    });
  });
});
