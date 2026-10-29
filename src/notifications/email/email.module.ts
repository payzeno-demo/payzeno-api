/**
 * EmailModule — the outbox, the templates, the SMTP transport and the job that drains them.
 *
 * Global so any feature module can queue an email without importing this one: `EmailService`
 * has callers in identity (signup, invites, resets, onboarding decisions), disputes, the ledger
 * consumer and the money path, and an import edge from each of them would be ceremony around
 * one injectable. It imports nothing feature-shaped back, so it cannot close a cycle.
 */
import { Global, Module } from '@nestjs/common';

import { CommonModule } from '../../common/common.module';

import { EmailDeliveryJob } from './email-delivery.job';
import { EmailOutboxRepository } from './email-outbox.repository';
import { EmailService } from './email.service';
import { MAIL_TRANSPORT, SmtpMailTransport } from './smtp.transport';

@Global()
@Module({
  imports: [CommonModule],
  providers: [
    EmailOutboxRepository,
    EmailService,
    SmtpMailTransport,
    { provide: MAIL_TRANSPORT, useExisting: SmtpMailTransport },
    EmailDeliveryJob,
  ],
  exports: [EmailService],
})
export class EmailModule {}
