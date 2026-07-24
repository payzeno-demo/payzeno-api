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
  const now = new Date('2026-06-01T12:00:00.000Z');
  const config = {
    AWS_REGION: 'eu-west-1',
    AWS_ENDPOINT_URL: 'http://localstack:4566',
    WEBHOOK_SIGNING_KEK: 'alias/payzeno-webhook-kek',
  };

  let service: WebhookSecretService;

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

  beforeEach(() => {
    send.mockReset();
    send.mockImplementation(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'EncryptCommand') {
        return { CiphertextBlob: Buffer.from('cipher-new') };
      }
      const blob = command.input.CiphertextBlob as Buffer;
      return { Plaintext: Buffer.from(`plain:${blob.toString()}`) };
    });

    service = new WebhookSecretService(
      config as never,
      { now: () => now } as never,
      { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() } as never,
    );
  });

  it('mints prefixed secrets that are not guessable', () => {
    const a = service.generate();
    const b = service.generate();

    expect(a).toMatch(/^whsec_/);
    expect(a.length).toBeGreaterThan(40);
    expect(a).not.toEqual(b);
  });

  it('encrypts under the configured KEK, never storing plaintext', async () => {
    const cipher = await service.encrypt('whsec_x');

    expect(cipher).toEqual(Buffer.from('cipher-new'));
    expect(send.mock.calls[0][0].input.KeyId).toBe('alias/payzeno-webhook-kek');
  });

  it('caches a decrypted secret so delivery does not hit KMS per attempt', async () => {
    await service.decrypt(Buffer.from('c1'), 'cur:whe_1');
    await service.decrypt(Buffer.from('c1'), 'cur:whe_1');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns only the current secret outside a rotation overlap', async () => {
    const material = await service.signingMaterial(endpoint(), now);

    expect(material.current).toBe('plain:cipher-current');
    expect(material.previous).toBeNull();
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

  it('demotes the live secret to previous on rotation', async () => {
    const rotated = await service.rotate(endpoint());

    expect(rotated.previousEncrypted).toEqual(Buffer.from('cipher-current'));
    expect(rotated.encrypted).toEqual(Buffer.from('cipher-new'));
    expect(rotated.lastFour).toBe(rotated.plaintext.slice(-4));
    expect(rotated.rotatedAt).toEqual(now);
  });
});
