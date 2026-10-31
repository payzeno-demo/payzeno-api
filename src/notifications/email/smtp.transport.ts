/**
 * The SMTP seam. `EmailDeliveryJob` talks to `MailTransport`; nodemailer lives only here.
 *
 * SES's SMTP interface in AWS, any SMTP server locally (Mailpit, `sim-mail:1025`). Timeouts are
 * short and explicit because the job sends inline: nodemailer's defaults (2 minutes to connect)
 * would hold the delivery lease for a whole batch on one dead relay.
 *
 * A failure is classified, not just thrown: a 5xx reply is the relay refusing THIS message
 * (bad recipient, policy) and retrying it is noise; everything else — connection refused while
 * Mailpit is still starting, a timeout, a 4xx — is the relay's problem and is retried with
 * backoff.
 */
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { API_CONFIG, type ApiConfig } from '../../config/api-config.type';

export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

export interface SentMail {
  providerMessageId: string | null;
}

export class MailSendError extends Error {
  constructor(
    message: string,
    /** True when the relay rejected this message for good (an SMTP 5xx). */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = 'MailSendError';
  }
}

export interface MailTransport {
  send(mail: OutgoingMail): Promise<SentMail>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

/** What nodemailer attaches to a failed send. Not exported by its types. */
interface SmtpErrorFields {
  code?: string;
  responseCode?: number;
}

@Injectable()
export class SmtpMailTransport implements MailTransport, OnApplicationShutdown {
  private readonly transporter: Transporter;

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    const { smtpHost, smtpPort, smtpUser, smtpPassword } = config.email;

    this.transporter = createTransport({
      host: smtpHost,
      port: smtpPort,
      // 465 is implicit TLS; 587 (SES) upgrades with STARTTLS; 1025 (Mailpit) is plain.
      secure: smtpPort === 465,
      auth: smtpUser && smtpPassword ? { user: smtpUser, pass: smtpPassword } : undefined,
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 15_000,
    });
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    try {
      const info = await this.transporter.sendMail(mail);
      const messageId: unknown = info.messageId;
      return { providerMessageId: typeof messageId === 'string' ? messageId : null };
    } catch (err) {
      const fields: SmtpErrorFields = err instanceof Error ? (err as Error & SmtpErrorFields) : {};
      const permanent = typeof fields.responseCode === 'number' && fields.responseCode >= 500;
      const detail = [fields.code, fields.responseCode, err instanceof Error ? err.message : String(err)]
        .filter((part) => part !== undefined && part !== '')
        .join(' ');
      throw new MailSendError(detail.slice(0, 500), permanent);
    }
  }

  onApplicationShutdown(): void {
    this.transporter.close();
  }
}
