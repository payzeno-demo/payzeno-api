import type { Message } from '@aws-sdk/client-sqs';
import type { EntityManager } from 'typeorm';
import type { EventType, PayzenoEvent } from '@payzeno/contracts/events';
import { BaseEventConsumer } from './consumer';

class FakeSqs {
  readonly deleted: string[] = [];
  send = jest.fn(async (command: { input?: Record<string, unknown> }) => {
    const handle = command.input?.ReceiptHandle;
    if (typeof handle === 'string') {
      this.deleted.push(handle);
    }
    return {};
  });
}

class RecordingConsumer extends BaseEventConsumer {
  readonly consumerName = 'recording';
  let claim: jest.Mock;
  let consumer: RecordingConsumer;

  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn(),
  };

  it('acknowledges and drops a type it does not handle', async () => {
    await consumer.processMessage(sqsMessage(envelope({ type: 'payment.captured' as EventType })));

    expect(consumer.handled).toHaveLength(0);
    expect(claim).not.toHaveBeenCalled();
    expect(sqs.deleted).toEqual(['rh-1']);
  });

  it('skips the handler entirely when the claim loses the race', async () => {
    claim.mockResolvedValueOnce(false);

    await consumer.processMessage(sqsMessage(envelope()));

    expect(consumer.handled).toHaveLength(0);
    // Still acknowledged: someone else did the work, the message is done.
    expect(sqs.deleted).toEqual(['rh-1']);
  });

  it('leaves the message on the queue when the handler throws', async () => {
    consumer.shouldThrow = true;

    await consumer.processMessage(sqsMessage(envelope()));

    expect(sqs.deleted).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      'consumer.handler_failed',
      expect.any(Error),
      expect.objectContaining({ event_id: 'evt_01HZZZ' }),
    );
  });

});
