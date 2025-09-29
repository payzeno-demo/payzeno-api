import { Test } from '@nestjs/testing';

import { NoopLogger, PayzenoLogger } from 'src/common/logging/logger';
import { ChargesService } from 'src/payments/charges.service';
import { DisputesService } from 'src/disputes/disputes.service';
import { OutboxEventPublisher } from 'src/events/outbox-event.publisher';
import { ProcessorRouter } from 'src/payments/processor/processor.router';
import { ProcessorWebhookService } from 'src/payments/processor-webhook.service';
import { RefundsService } from 'src/refunds/refunds.service';

import { makeCharge, makeSettledCharge } from 'test/factories/charge.factory';

// yael — this is the longest method in the repo and I know it. Splitting it means
// splitting the acquirer's event vocabulary across five files and I would rather have
// one switch I can read. TODO(PAY-1988): revisit when nordpay adds partial reversals.
describe('ProcessorWebhookService', () => {
  let service: ProcessorWebhookService;
  let router: jest.Mocked<ProcessorRouter>;
  let adapter: { acquirer: 'worldflow'; parseWebhook: jest.Mock };

  it('drops an event whose network transaction id matches nothing', async () => {
    charges.findByProcessorReference.mockResolvedValue(null as never);
    adapter.parseWebhook.mockReturnValue(parsed('capture_settled'));

    // Acquirers replay their whole file after an outage, including transactions from
    // merchants that have since left. Logging and dropping is correct; throwing makes
    // the acquirer retry forever.
    await expect(service.handle('worldflow', Buffer.from('{}'), 'sig')).resolves.toBeUndefined();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

});
