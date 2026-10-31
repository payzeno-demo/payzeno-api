import { WebhookEndpointsService } from './webhook-endpoints.service';

describe('WebhookEndpointsService', () => {
  const now = new Date('2026-05-01T00:00:00.000Z');

  let repo: {
    count: jest.Mock;
    insert: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    findEnabledFor: jest.Mock;
    findStale: jest.Mock;
    disable: jest.Mock;
    recordSuccess: jest.Mock;
    recordFailure: jest.Mock;
    find: jest.Mock;
  };
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
      { opaque: (prefix: string) => `${prefix}01HTEST` } as never,
      { now: () => now } as never,
      { runtime: { nodeEnv: 'production' } } as never,
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

  it('accepts an http endpoint outside production — the local demo shops have no certificate', async () => {
    // Regression: assertHttps refused http://sim-shops:3000/... in every environment.
    const dev = new WebhookEndpointsService(
      repo as never,
      secrets as never,
      { opaque: (prefix: string) => `${prefix}01HTEST` } as never,
      { now: () => now } as never,
      { runtime: { nodeEnv: 'development' } } as never,
      logger as never,
    );

    const created = await dev.create('mer_1', true, {
      ...(dto as object),
      url: 'http://sim-shops:3000/webhooks/northwind',
    } as never);

    expect(created.url).toBe('http://sim-shops:3000/webhooks/northwind');
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

  it('delegates the fanout lookup straight to the containment query', async () => {
    await service.listEnabledFor('mer_1', 'payout.failed', true);

    expect(repo.findEnabledFor).toHaveBeenCalledWith('mer_1', 'payout.failed', true);
  });

  it('disables endpoints with no success in 72h and 20 consecutive failures', async () => {
    repo.findStale.mockResolvedValueOnce([
      { id: 'whe_1', merchantId: 'mer_1', consecutiveFailureCount: 21 },
    ]);

    const disabled = await service.disableStale(20, 50);

    expect(disabled).toEqual(['whe_1']);
    expect(repo.findStale).toHaveBeenCalledWith(
      new Date('2026-04-28T00:00:00.000Z'),
      20,
      50,
    );
    expect(repo.disable).toHaveBeenCalledWith('whe_1');
  });

  it('resets the failure counter on a successful delivery', async () => {
    await service.recordDeliveryOutcome('whe_1', true);
    expect(repo.recordSuccess).toHaveBeenCalledWith('whe_1', now);

    await service.recordDeliveryOutcome('whe_1', false);
    expect(repo.recordFailure).toHaveBeenCalledWith('whe_1');
  });
});
