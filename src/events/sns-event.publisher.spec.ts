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

  let publisher: SnsEventPublisher;

  beforeEach(() => {
    send.mockClear();
    publisher = new SnsEventPublisher(
      config as never,
      { now: () => new Date('2026-04-02T08:00:00.000Z') } as never,
      { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() } as never,
      { generate: () => 'evt_01HSNS' } as never,
    );
  });

  it('routes payment events to the payments topic', async () => {
    await publisher.publish(
      'payment.failed',
      {
        charge_id: null,
        payment_intent_id: 'pi_1',
        merchant_id: 'mer_1',
        amount_minor: 100,
        currency: 'USD',
        failure_code: 'do_not_honor',
        failure_message: 'declined',
        retryable: false,
        failed_at: '2026-04-02T08:00:00.000Z',
      },
      {
        merchantId: 'mer_1',
        correlationId: 'corr_1',
        causationId: null,
        livemode: true,
        occurredAt: '2026-04-02T08:00:00.000Z',
      },
    );

    const command = send.mock.calls[0][0] as unknown as PublishCommand;
    expect(command.input.TopicArn).toBe(config.aws.snsPaymentsTopicArn);
    expect(command.input.MessageAttributes?.event_type?.StringValue).toBe('payment.failed');
  });

  it('batches per topic and chunks at the SNS limit of ten', async () => {
    const events = Array.from({ length: 12 }, (_, i) => event('payment.captured', `evt_${i}`));

    const ids = await publisher.publishBatch(events);

    expect(ids).toHaveLength(12);
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0][0] as unknown as PublishBatchCommand;
    expect(first.input.PublishBatchRequestEntries).toHaveLength(10);
  });

  it('splits a mixed batch across the two topics payzeno-api owns', async () => {
    await publisher.publishBatch([event('payment.captured', 'evt_a'), event('merchant.updated', 'evt_b')]);

    const arns = send.mock.calls.map(
      (call) => (call[0] as unknown as PublishBatchCommand).input.TopicArn,
    );
    expect(new Set(arns)).toEqual(
      new Set([config.aws.snsPaymentsTopicArn, config.aws.snsMerchantTopicArn]),
    );
  });

  it('covers every event type in the contract', () => {
    expect(() => topicOf('invoice.issued')).not.toThrow();
    expect(topicOf('dispute.closed')).toBe('payzeno-payments-events');
    expect(topicOf('merchant.bank_account_verified')).toBe('payzeno-merchant-events');
  });

  it('marks ledger and billing events as not ours to originate', () => {
    expect(isApiOwnedEvent('payment.authorized')).toBe(true);
    expect(isApiOwnedEvent('merchant.created')).toBe(true);
    expect(isApiOwnedEvent('settlement.duplicate_detected')).toBe(false);
    expect(isApiOwnedEvent('invoice.issued')).toBe(false);
  });
});
