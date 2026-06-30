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
  let disputes: jest.Mocked<DisputesService>;
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

  function parsed(kind: string, overrides: Record<string, unknown> = {}) {
    return {
      acquirer: 'worldflow' as const,
      kind,
      networkTransactionId: 'ntx_1',
      occurredAt: '2026-01-15T12:00:00.000Z',
      raw: {},
      ...overrides,
    };
  }

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

  it('marks a charge settled on capture_settled', async () => {
    charges.findByProcessorReference.mockResolvedValue(makeSettledCharge() as never);
    adapter.parseWebhook.mockReturnValue(parsed('capture_settled'));

    await service.handle('worldflow', Buffer.from('{}'), 'sig');

    expect(charges.findByProcessorReference).toHaveBeenCalledWith('worldflow', 'ntx_1');
  });

  it('emits refund.succeeded on refund_settled', async () => {
    adapter.parseWebhook.mockReturnValue(
      parsed('refund_settled', { raw: { refund_reference: 'wf_ref_1' } }),
    );

    await service.handle('worldflow', Buffer.from('{}'), 'sig');

    expect(publisher.publish).toHaveBeenCalledWith(
      'refund.succeeded',
      expect.anything(),
      expect.anything(),
    );
  });

  it('emits refund.failed when the acquirer reports a failed reversal', async () => {
    adapter.parseWebhook.mockReturnValue(
      parsed('refund_settled', { raw: { refund_reference: 'wf_ref_2', failed: true } }),
    );

    await service.handle('worldflow', Buffer.from('{}'), 'sig');

    expect(publisher.publish).toHaveBeenCalledWith(
      'refund.failed',
      expect.anything(),
      expect.anything(),
    );
  });

  it('handles chargeback_reversed without inventing a new dispute', async () => {
    adapter.parseWebhook.mockReturnValue(parsed('chargeback_reversed'));

    await service.handle('worldflow', Buffer.from('{}'), 'sig');

    expect(disputes.openFromWebhook).not.toHaveBeenCalled();
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

  it('rethrows a signature failure so the route returns non-2xx', async () => {
    adapter.parseWebhook.mockImplementation(() => {
      throw new Error('bad signature');
    });

    await expect(service.handle('worldflow', Buffer.from('{}'), 'nope')).rejects.toThrow();
  });
});
