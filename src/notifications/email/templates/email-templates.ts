/**
 * Every email Payzeno sends, as content (RFC platform-v2 §2). Keyed by `EmailTemplate` from
 * @payzeno/contracts, so a template added to the contract without copy here is a compile error
 * rather than a blank email in production.
 *
 * The data keys each template reads are the ones its caller agreed to send; anything missing
 * renders blank instead of failing the send — an email with an empty "Reason:" row is a support
 * question, an email that never goes out is an incident. `value()` is the only accessor.
 *
 * `amount` is always a DISPLAY string (`formatMoney` from @payzeno/contracts/money, e.g.
 * "€12.50"). Templates never format money: they would have to know the currency exponent, and
 * JPY has none.
 */
import type { EmailTemplate } from '@payzeno/contracts';

import { renderLayout, type EmailContent, type RenderedEmail } from './email-layout';

export type EmailTemplateData = Readonly<Record<string, string | number | boolean | null>>;

export interface EmailRenderContext {
  /** CONSOLE_PUBLIC_URL, the fallback for templates whose caller did not send `console_url`. */
  consoleUrl: string;
}

type Value = (key: string) => string;
type TemplateDefinition = (value: Value, ctx: EmailRenderContext) => EmailContent;

const VERIFY_TTL_COPY = 'This link expires in 72 hours and can be used once.';

const DEFINITIONS: Readonly<Record<EmailTemplate, TemplateDefinition>> = {
  // -- merchant users ---------------------------------------------------------------------------
  signup_verify: (v) => ({
    subject: `Confirm your email to finish setting up ${v('merchant_name')} on Payzeno`,
    heading: 'Confirm your email address',
    paragraphs: [
      `Thanks for signing up ${v('merchant_name')} with Payzeno. Confirm that this is your email address and you will be signed in to your dashboard, where you can start testing right away and finish activating your account.`,
    ],
    action: { label: 'Confirm email address', url: v('verify_url') },
    footnote: `${VERIFY_TTL_COPY} If you did not sign up for Payzeno, you can ignore this email.`,
  }),

  team_invite: (v) => ({
    subject: `${v('inviter_name')} invited you to ${v('merchant_name')} on Payzeno`,
    heading: `Join ${v('merchant_name')} on Payzeno`,
    paragraphs: [
      `${v('inviter_name')} has invited you to the ${v('merchant_name')} team on Payzeno. Accept the invitation to choose a password and sign in to the dashboard.`,
    ],
    action: { label: 'Accept invitation', url: v('accept_url') },
    footnote: `${VERIFY_TTL_COPY} If you were not expecting this invitation, you can ignore this email.`,
  }),

  password_reset: (v) => ({
    subject: 'Reset your Payzeno password',
    heading: 'Reset your password',
    paragraphs: [
      v('merchant_name')
        ? `We received a request to reset the password for your ${v('merchant_name')} login on Payzeno.`
        : 'We received a request to reset the password for your Payzeno login.',
      'Choose a new password with the link below. Signing in again will be required on every device.',
    ],
    action: { label: 'Reset password', url: v('reset_url') },
    footnote:
      'This link expires in 1 hour and can be used once. If you did not ask to reset your password, you can ignore this email — your password will not change.',
  }),

  onboarding_approved: (v, ctx) => ({
    subject: `${v('merchant_name')} is approved for live payments`,
    heading: 'Your account is activated',
    paragraphs: [
      `Good news: we have reviewed your application and ${v('merchant_name')} can now accept live payments and receive payouts.`,
      v('message') ? `A note from our team: ${v('message')}` : '',
    ],
    action: { label: 'Go to your dashboard', url: v('console_url') || ctx.consoleUrl },
  }),

  onboarding_rejected: (v, ctx) => ({
    subject: `An update on your Payzeno application for ${v('merchant_name')}`,
    heading: 'We could not activate your account',
    paragraphs: [
      `After reviewing your application, we are unable to activate ${v('merchant_name')} for live payments.`,
      v('message') ? `Reason: ${v('message')}` : '',
      'Test mode stays available. If you think this decision is wrong, reply through the support page in your dashboard.',
    ],
    action: { label: 'View your account', url: v('console_url') || ctx.consoleUrl },
  }),

  onboarding_info_requested: (v, ctx) => ({
    subject: `Action needed: more information for ${v('merchant_name')}`,
    heading: 'We need a little more information',
    paragraphs: [
      `We are reviewing ${v('merchant_name')} and need a few more details before we can activate live payments.`,
      v('message') ? `What we need: ${v('message')}` : '',
      'Update your application and submit it again; we will pick it up from there.',
    ],
    action: { label: 'Update your application', url: v('console_url') || ctx.consoleUrl },
  }),

  dispute_opened: (v, ctx) => ({
    subject: `A payment to ${v('merchant_name')} has been disputed`,
    heading: 'A customer disputed a payment',
    paragraphs: [
      `A cardholder has disputed a payment to ${v('merchant_name')}. For a chargeback, the disputed amount and the dispute fee are held from your balance while it is open.`,
      'Submit evidence in your dashboard to contest it. If there is a response deadline and you do nothing, the dispute is lost when it passes.',
    ],
    details: [
      ['Amount', v('amount')],
      ['Reason', v('reason')],
      ['Respond by', v('respond_by')],
    ],
    action: { label: 'Respond to the dispute', url: v('console_url') || ctx.consoleUrl },
  }),

  payout_paid: (v, ctx) => ({
    subject: `Your payout of ${v('amount')} has been paid`,
    heading: 'Your payout is on its way',
    paragraphs: [
      `We have sent a payout from your ${v('merchant_name')} balance. Depending on your bank it can take a business day to appear on your statement.`,
    ],
    details: [
      ['Amount', v('amount')],
      ['Bank account', v('bank_last4') ? `•••• ${v('bank_last4')}` : ''],
    ],
    action: { label: 'View payouts', url: v('console_url') || `${ctx.consoleUrl}/payouts` },
  }),

  payout_failed: (v, ctx) => ({
    subject: `Your payout of ${v('amount')} failed`,
    heading: 'A payout could not be completed',
    paragraphs: [
      `A payout from your ${v('merchant_name')} balance was returned by the bank. The funds are back in your Payzeno balance.`,
      'Check your bank details in the dashboard; we will retry the next scheduled payout.',
    ],
    details: [
      ['Amount', v('amount')],
      ['Bank account', v('bank_last4') ? `•••• ${v('bank_last4')}` : ''],
      ['Reason', v('failure_reason')],
    ],
    action: { label: 'Check bank details', url: v('console_url') || `${ctx.consoleUrl}/payouts` },
  }),

  payment_review_opened: (v, ctx) => ({
    subject: `A payment of ${v('amount')} to ${v('merchant_name')} is under review`,
    heading: 'A payment is being reviewed',
    paragraphs: [
      `Payzeno's risk team is reviewing a payment to ${v('merchant_name')} before it is captured. You do not need to do anything: we will either capture it or cancel it, and you will see the outcome on the payment.`,
    ],
    details: [
      ['Amount', v('amount')],
      ['Payment', v('payment_id')],
    ],
    action: { label: 'View the payment', url: v('console_url') || ctx.consoleUrl },
  }),

  // -- shoppers -------------------------------------------------------------------------------
  receipt: (v) => ({
    subject: `Your receipt from ${v('merchant_name')}`,
    heading: `Receipt from ${v('merchant_name')}`,
    paragraphs: [`Thank you for your payment to ${v('merchant_name')}.`],
    details: [
      ['Amount paid', v('amount')],
      ['Description', v('description')],
      ['Payment method', v('card_last4') ? `Card ending in ${v('card_last4')}` : ''],
      ['Date', v('date')],
      ['Payment ID', v('payment_id')],
    ],
    footnote: `Questions about this payment? Contact ${v('merchant_name')} directly. Payzeno processes payments on their behalf.`,
  }),

  refund_receipt: (v) => ({
    subject: `Your refund from ${v('merchant_name')}`,
    heading: `${v('merchant_name')} sent you a refund`,
    paragraphs: [
      `${v('merchant_name')} has refunded ${v('amount')} to your card. Refunds usually appear on your statement within 5 to 10 business days.`,
    ],
    details: [
      ['Amount refunded', v('amount')],
      ['Original payment', v('payment_id')],
    ],
    footnote: `Questions about this refund? Contact ${v('merchant_name')} directly.`,
  }),

  payment_declined_after_review: (v) => ({
    subject: `Your payment to ${v('merchant_name')} was not completed`,
    heading: 'Your payment was not completed',
    paragraphs: [
      `Your payment of ${v('amount')} to ${v('merchant_name')} could not be completed after review. You have not been charged; any pending authorisation on your card will be released by your bank.`,
    ],
    footnote: `If you still want to make this purchase, contact ${v('merchant_name')}.`,
  }),

  subscription_started: (v) => ({
    subject: `Your ${v('product_name')} subscription with ${v('merchant_name')}`,
    heading: 'Your subscription has started',
    paragraphs: [`Thanks for subscribing to ${v('product_name')} from ${v('merchant_name')}.`],
    details: [
      ['Plan', v('product_name')],
      ['Amount', v('amount')],
      ['Current period ends', v('period_end')],
    ],
    footnote: `Your card will be charged automatically at the start of each period. To cancel, contact ${v('merchant_name')}.`,
  }),

  subscription_renewed: (v) => ({
    subject: `Your ${v('product_name')} subscription has renewed`,
    heading: 'Your subscription has renewed',
    paragraphs: [`Your ${v('product_name')} subscription with ${v('merchant_name')} has renewed.`],
    details: [
      ['Plan', v('product_name')],
      ['Amount charged', v('amount')],
      ['Current period ends', v('period_end')],
    ],
    footnote: `To cancel, contact ${v('merchant_name')}.`,
  }),

  subscription_payment_failed: (v) => ({
    subject: `Payment failed for your ${v('product_name')} subscription`,
    heading: 'We could not charge your card',
    paragraphs: [
      `The renewal payment of ${v('amount')} for your ${v('product_name')} subscription with ${v('merchant_name')} was declined. Update your card to keep your subscription active.`,
    ],
    details: [
      ['Plan', v('product_name')],
      ['Amount due', v('amount')],
      ['Next attempt', v('next_retry')],
    ],
    action: { label: 'Update your card', url: v('update_url') },
    footnote: 'If every retry fails, the subscription will be canceled.',
  }),

  subscription_canceled: (v) => ({
    subject: `Your ${v('product_name')} subscription has been canceled`,
    heading: 'Your subscription has been canceled',
    paragraphs: [
      `Your ${v('product_name')} subscription with ${v('merchant_name')} has been canceled and you will not be charged again.`,
    ],
    footnote: `To subscribe again, visit ${v('merchant_name')}.`,
  }),
};

function accessor(data: EmailTemplateData): Value {
  return (key) => {
    const raw = data[key];
    return raw === null || raw === undefined ? '' : String(raw);
  };
}

export function renderEmail(
  template: EmailTemplate,
  data: EmailTemplateData,
  ctx: EmailRenderContext,
): RenderedEmail {
  return renderLayout(DEFINITIONS[template](accessor(data), ctx));
}

/** Subject only — `EmailService.queue` stores it so the admin lookup can show unsent mail. */
export function renderSubject(
  template: EmailTemplate,
  data: EmailTemplateData,
  ctx: EmailRenderContext,
): string {
  return renderEmail(template, data, ctx).subject;
}
