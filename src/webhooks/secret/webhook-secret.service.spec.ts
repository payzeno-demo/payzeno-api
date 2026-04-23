import { ROTATION_OVERLAP_MS, WebhookSecretService } from './webhook-secret.service';
import type { WebhookEndpointEntity } from '../webhook-endpoint.entity';

const send = jest.fn();
jest.mock('@aws-sdk/client-kms', () => {
  const actual = jest.requireActual('@aws-sdk/client-kms');
  return {
    ...actual,
    KMSClient: jest.fn().mockImplementation(() => ({ send: (cmd: unknown) => send(cmd) })),
  };
});

describe('WebhookSecretService', () => {
  const config = {
    AWS_REGION: 'eu-west-1',
    AWS_ENDPOINT_URL: 'http://localstack:4566',
    WEBHOOK_SIGNING_KEK: 'alias/payzeno-webhook-kek',
  };

  function endpoint(overrides: Partial<WebhookEndpointEntity> = {}): WebhookEndpointEntity {
    return {
      id: 'whe_1',
      merchantId: 'mer_1',
      signingSecretEncrypted: Buffer.from('cipher-current'),
      signingSecretPreviousEncrypted: null,
      rotatedAt: null,
      ...overrides,
    } as WebhookEndpointEntity;
  }

  it('mints prefixed secrets that are not guessable', () => {
    const a = service.generate();
    const b = service.generate();

    expect(a).toMatch(/^whsec_/);
    expect(a.length).toBeGreaterThan(40);
    expect(a).not.toEqual(b);
  });

  it('returns both secrets during the overlap window', async () => {
    const material = await service.signingMaterial(
      endpoint({
        signingSecretPreviousEncrypted: Buffer.from('cipher-old'),
        rotatedAt: new Date(now.getTime() - 60_000),
      }),
      now,
    );

    expect(material.current).toBe('plain:cipher-current');
    expect(material.previous).toBe('plain:cipher-old');
  });

  it('stops sending the previous signature once the overlap expires', async () => {
    const material = await service.signingMaterial(
      endpoint({
        signingSecretPreviousEncrypted: Buffer.from('cipher-old'),
        rotatedAt: new Date(now.getTime() - ROTATION_OVERLAP_MS - 1),
      }),
      now,
    );

    expect(material.previous).toBeNull();
  });

});
