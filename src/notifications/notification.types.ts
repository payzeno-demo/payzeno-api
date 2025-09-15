/**
 * The wire shape of `/ws/notifications`.
 *
 * This is the console's `useNotificationStream()` contract. It is deliberately NOT the bus
 * envelope: the bus carries reversal transaction ids, idempotency keys and chunk indices, and
 * none of that belongs in a browser. A notification is a headline, a severity and enough of a
 * link for the console to route the click.
 *
 * `dispute.opened` arrives here from the payments topic while `payout.failed` and
 * `settlement.completed` arrive from the ledger topic, which is why the
 * `payzeno-console-notifications` queue subscribes to two topics (events.ts header table).
 */
import type { EventType, PayzenoEvent } from '@payzeno/contracts/events';
import type { IsoTimestamp, MerchantId, MinorUnits } from '@payzeno/contracts';

/** Every type the relay is allowed to forward. Anything else is dropped, not guessed at. */
export const RELAYED_EVENT_TYPES: readonly EventType[] = [
  'payout.failed',
  'settlement.completed',
  'dispute.opened',
];

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface Notification {
  /** `ntf_` + the source event id, so the client can dedupe a reconnect replay. */
  id: string;
  type: EventType;
  merchant_id: MerchantId;
  severity: NotificationSeverity;
  title: string;
  body: string;
  /** Console-relative route the notification links to, e.g. `/payouts/po_1`. */
  href: string | null;
  amount_minor: MinorUnits | null;
  currency: string | null;
  occurred_at: IsoTimestamp;
  livemode: boolean;
}

/** Frames the socket sends. The client switches on `kind`. */
export type ServerFrame =
  | { kind: 'ready'; merchant_id: MerchantId; livemode: boolean }
  | { kind: 'notification'; notification: Notification }
  | { kind: 'pong'; at: IsoTimestamp }
  | { kind: 'error'; message: string };

/** Frames the client may send. Anything else closes the socket. */
export type ClientFrame = { kind: 'ping' } | { kind: 'ack'; id: string };

export function parseClientFrame(raw: string): ClientFrame | null {
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; id?: unknown };
    if (parsed.kind === 'ping') {
      return { kind: 'ping' };
    }
    if (parsed.kind === 'ack' && typeof parsed.id === 'string') {
      return { kind: 'ack', id: parsed.id };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Bus event → notification. Returns null when the event carries no tenant: a
 * `settlement.completed` for a batch that spans merchants has `envelope.merchant_id = null`,
 * and there is no socket to send it to. The console gets its settlement view from the REST
 * read-through instead.
 */
export function toNotification(event: PayzenoEvent): Notification | null {
  if (!event.merchant_id) {
    return null;
  }

  const base = {
    id: `ntf_${event.id}`,
    type: event.type,
    merchant_id: event.merchant_id,
    occurred_at: event.occurred_at,
    livemode: event.livemode,
  };

  switch (event.type) {
    case 'payout.failed': {
      const payload = event.payload;
      return {
        ...base,
        severity: payload.requires_merchant_action ? 'critical' : 'warning',
        title: 'Payout failed',
        body: payload.requires_merchant_action
          ? `${payload.failure_message} — update your bank details to retry.`
          : `${payload.failure_message} Funds were returned to your balance.`,
        href: `/payouts/${payload.payout_id}`,
        amount_minor: payload.amount_minor,
        currency: payload.currency,
      };
    }
    case 'settlement.completed': {
      const payload = event.payload;
      return {
        ...base,
        severity: payload.items_failed > 0 ? 'warning' : 'info',
        title: 'Settlement complete',
        body:
          `${payload.items_settled} of ${payload.items_total} items settled for ` +
          `${payload.processing_date}.` +
          (payload.items_failed > 0 ? ` ${payload.items_failed} need review.` : ''),
        href: `/settlements/${payload.batch_id}`,
        amount_minor: payload.net_total_minor,
        currency: payload.currency,
      };
    }
    case 'dispute.opened': {
      const payload = event.payload;
      return {
        ...base,
        severity: 'critical',
        title: 'New dispute',
        body: `${payload.reason} — evidence due by ${payload.evidence_due_by}.`,
        href: `/disputes/${payload.dispute_id}`,
        amount_minor: payload.amount_minor,
        currency: payload.currency,
      };
    }
    default:
      return null;
  }
}
