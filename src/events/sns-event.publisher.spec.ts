import { PublishBatchCommand, PublishCommand } from '@aws-sdk/client-sns';
import type { PayzenoEvent } from '@payzeno/contracts/events';
import { isApiOwnedEvent, topicOf } from './publisher';
import { SnsEventPublisher } from './sns-event.publisher';

const send = jest.fn(async () => ({}));
jest.mock('@aws-sdk/client-sns', () => {
  const actual = jest.requireActual('@aws-sdk/client-sns');
  return {
    ...actual,
    SNSClient: jest.fn().mockImplementation(() => ({ send: (cmd: unknown) => send(cmd as never) })),
  };
});

describe('SnsEventPublisher', () => {
  // The shape is `ApiConfig`, not the raw env. `configuration.ts` is the only file that ever
  // sees a screaming-snake name; everything downstream gets the nested object.
  const config = {
    aws: {
      region: 'eu-west-1',
      endpointUrl: 'http://localstack:4566',
      snsPaymentsTopicArn: 'arn:aws:sns:eu-west-1:000000000000:payzeno-payments',
      snsMerchantTopicArn: 'arn:aws:sns:eu-west-1:000000000000:payzeno-merchants',
    },
  };

  beforeEach(() => {
    send.mockClear();
    publisher = new SnsEventPublisher(
      config as never,
      { now: () => new Date('2026-04-02T08:00:00.000Z') } as never,
      { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() } as never,
      { generate: () => 'evt_01HSNS' } as never,
    );
  });

});
