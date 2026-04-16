import { WebhookEndpointsService } from './webhook-endpoints.service';

describe('WebhookEndpointsService', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');

  let secrets: { generate: jest.Mock; encrypt: jest.Mock; lastFour: jest.Mock; rotate: jest.Mock };
  let service: WebhookEndpointsService;

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    repo = {
      count: jest.fn(async () => 0),
      insert: jest.fn(async () => undefined),
      save: jest.fn(async (row: unknown) => row),
      delete: jest.fn(async () => undefined),
      findEnabledFor: jest.fn(async () => []),
      findStale: jest.fn(async () => []),
      disable: jest.fn(async () => undefined),
      recordSuccess: jest.fn(async () => undefined),
      recordFailure: jest.fn(async () => 1),
      find: jest.fn(async () => []),
    };
    secrets = {
      generate: jest.fn(() => 'whsec_abcdefgh1234'),
      encrypt: jest.fn(async () => Buffer.from('cipher')),
      lastFour: jest.fn((secret: string) => secret.slice(-4)),
      rotate: jest.fn(),
    };

    service = new WebhookEndpointsService(
      repo as never,
      secrets as never,
      { generate: () => 'whe_01HTEST' } as never,
      { now: () => now } as never,
      logger as never,
    );
  });

  const dto = {
    url: 'https://merchant.example.com/hooks/payzeno',
    enabled_events: ['payment.captured', 'refund.succeeded'],
  } as never;

  it('returns the plaintext signing secret exactly once, on create', async () => {
    const created = await service.create('mer_1', true, dto);

    expect(created.signing_secret).toBe('whsec_abcdefgh1234');
    expect(created.signing_secret_last_four).toBe('1234');
    // The row itself never carries plaintext.
    const [row] = repo.insert.mock.calls[0];
    expect(row.signingSecretEncrypted).toEqual(Buffer.from('cipher'));
    expect(Object.keys(row)).not.toContain('signingSecret');
  });

  it('rejects a non-https endpoint', async () => {
    await expect(
      service.create('mer_1', true, { ...(dto as object), url: 'http://insecure.example' } as never),
    ).rejects.toThrow(/https/);
  });

  it('rejects an event type outside PUBLIC_EVENT_TYPES', async () => {
    await expect(
      service.create('mer_1', true, {
        ...(dto as object),
        enabled_events: ['settlement.duplicate_detected'],
      } as never),
    ).rejects.toThrow(/unknown event types/);
  });

  it('caps the number of endpoints per merchant', async () => {
    repo.count.mockResolvedValueOnce(16);

    await expect(service.create('mer_1', true, dto)).rejects.toThrow(/too many webhook endpoints/);
  });

  it('resets the failure counter on a successful delivery', async () => {
    await service.recordDeliveryOutcome('whe_1', true);
    expect(repo.recordSuccess).toHaveBeenCalledWith('whe_1', now);

    await service.recordDeliveryOutcome('whe_1', false);
    expect(repo.recordFailure).toHaveBeenCalledWith('whe_1');
  });
});
