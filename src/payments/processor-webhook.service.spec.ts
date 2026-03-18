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
  let charges: jest.Mocked<ChargesService>;
  let refunds: jest.Mocked<RefundsService>;
  let publisher: jest.Mocked<OutboxEventPublisher>;
  let router: jest.Mocked<ProcessorRouter>;
  let adapter: { acquirer: 'worldflow'; parseWebhook: jest.Mock };

  beforeEach(async () => {
    adapter = { acquirer: 'worldflow', parseWebhook: jest.fn() };

    charges = {
      findByProcessorReference: jest.fn().mockResolvedValue(makeCharge()),
      markSettled: jest.fn(),
    } as unknown as jest.Mocked<ChargesService>;

    disputes = {
      openFromWebhook: jest.fn(),
      closeFromWebhook: jest.fn(),
    } as unknown as jest.Mocked<DisputesService>;

    refunds = { markSettledFromWebhook: jest.fn() } as unknown as jest.Mocked<RefundsService>;
    publisher = { publish: jest.fn() } as unknown as jest.Mocked<OutboxEventPublisher>;
    router = { forAcquirer: jest.fn().mockReturnValue(adapter) } as unknown as jest.Mocked<ProcessorRouter>;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProcessorWebhookService,
        { provide: ChargesService, useValue: charges },
        { provide: DisputesService, useValue: disputes },
        { provide: RefundsService, useValue: refunds },
        { provide: OutboxEventPublisher, useValue: publisher },
        { provide: ProcessorRouter, useValue: router },
        { provide: PayzenoLogger, useValue: new NoopLogger() },
      ],
    }).compile();

    service = moduleRef.get(ProcessorWebhookService);
  });

  it('parses through the acquirer’s own adapter', async () => {
    adapter.parseWebhook.mockReturnValue(parsed('capture_settled'));

    await service.handle('worldflow', Buffer.from('{}'), 't=1,v1=abc');

    expect(router.forAcquirer).toHaveBeenCalledWith('worldflow');
    expect(adapter.parseWebhook).toHaveBeenCalledWith(expect.any(Buffer), 't=1,v1=abc');
  });

  it('opens a dispute on dispute_opened', async () => {
    adapter.parseWebhook.mockReturnValue(
      parsed('dispute_opened', {
        raw: { reason: 'fraudulent', amount_minor: 4_500, network_reason_code: '10.4' },
      }),
    );

    await service.handle('worldflow', Buffer.from('{}'), 'sig');

    expect(disputes.openFromWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ id: expect.any(String) }),
      expect.objectContaining({ reason: 'fraudulent' }),
    );
  });

  it('closes a dispute on dispute_closed', async () => {
    adapter.parseWebhook.mockReturnValue(parsed('dispute_closed', { raw: { outcome: 'won' } }));

    await service.handle('worldflow', Buffer.from('{}'), 'sig');

    expect(disputes.closeFromWebhook).toHaveBeenCalled();
  });

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
