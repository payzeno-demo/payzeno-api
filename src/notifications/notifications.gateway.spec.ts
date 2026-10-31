import type { IncomingMessage } from 'node:http';

import { AuthenticationRequiredException } from '../common/errors/auth.exceptions';

import { NotificationsGateway } from './notifications.gateway';
import type { Notification } from './notification.types';

describe('NotificationsGateway', () => {
  const now = 1_780_000_000_000;

  interface FakeSocket {
    sent: string[];
    closed: Array<{ code: number; reason: string }>;
    handlers: Record<string, (data: unknown) => void>;
    send(payload: string): void;
    close(code: number, reason: string): void;
    on(event: string, handler: (data: unknown) => void): void;
  }

  function makeSocket(): FakeSocket {
    const socket: FakeSocket = {
      sent: [],
      closed: [],
      handlers: {},
      send(payload) {
        socket.sent.push(payload);
      },
      close(code, reason) {
        socket.closed.push({ code, reason });
      },
      on(event, handler) {
        socket.handlers[event] = handler;
      },
    };
    return socket;
  }

  function upgrade(cookie: string, csrf?: string): IncomingMessage {
    return {
      headers: {
        cookie,
        ...(csrf ? { 'x-payzeno-csrf': csrf } : {}),
      },
    } as unknown as IncomingMessage;
  }

  function notification(overrides: Partial<Notification> = {}): Notification {
    return {
      id: 'ntf_evt_1',
      type: 'payout.failed',
      merchant_id: 'mch_1',
      severity: 'critical',
      title: 'Payout failed',
      body: 'R01 — insufficient funds',
      href: '/payouts/po_1',
      amount_minor: 120_00,
      currency: 'USD',
      occurred_at: '2026-05-01T04:00:00.000Z',
      livemode: true,
      ...overrides,
    };
  }

  let sessions: { resolveForUpgrade: jest.Mock };
  let gateway: NotificationsGateway;

  beforeEach(() => {
    sessions = {
      resolveForUpgrade: jest.fn(async () => ({
        kind: 'dashboard_session',
        merchant_id: 'mch_1',
        user_id: 'usr_1',
        role: 'admin',
      })),
    };

    gateway = new NotificationsGateway(
      sessions as never,
      { nowMs: () => now, nowIso: () => new Date(now).toISOString() } as never,
      { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() } as never,
    );
  });

  it('accepts an upgrade with a session cookie and a matching CSRF header', async () => {
    const socket = makeSocket();

    await gateway.handleConnection(
      socket as never,
      upgrade('pz_session=sess_1; pz_csrf=tok_1', 'tok_1'),
    );

    expect(socket.closed).toHaveLength(0);
    expect(JSON.parse(socket.sent[0])).toEqual({
      kind: 'ready',
      merchant_id: 'mch_1',
      livemode: true,
    });
    expect(gateway.connectionCount()).toBe(1);
  });

  it('refuses an upgrade with no CSRF header — the cross-origin case', async () => {
    const socket = makeSocket();

    await gateway.handleConnection(socket as never, upgrade('pz_session=sess_1; pz_csrf=tok_1'));

    expect(socket.closed[0]).toEqual({ code: 4403, reason: 'permission_denied' });
    expect(gateway.connectionCount()).toBe(0);
  });

  it('refuses an upgrade whose CSRF header does not match the cookie', async () => {
    const socket = makeSocket();

    await gateway.handleConnection(
      socket as never,
      upgrade('pz_session=sess_1; pz_csrf=tok_1', 'tok_other'),
    );

    expect(socket.closed[0].code).toBe(4403);
  });

  it('refuses an upgrade whose session no longer resolves', async () => {
    sessions.resolveForUpgrade.mockRejectedValueOnce(
      new AuthenticationRequiredException('Session expired or unknown'),
    );
    const socket = makeSocket();

    await gateway.handleConnection(
      socket as never,
      upgrade('pz_session=stale; pz_csrf=tok_1', 'tok_1'),
    );

    expect(socket.closed[0]).toEqual({ code: 4401, reason: 'authentication_required' });
  });

  describe('push', () => {
    it('fans out to every socket of the merchant', async () => {
      const first = makeSocket();
      const second = makeSocket();
      await gateway.handleConnection(first as never, upgrade('pz_session=a; pz_csrf=t', 't'));
      await gateway.handleConnection(second as never, upgrade('pz_session=b; pz_csrf=t', 't'));

      const delivered = gateway.push(notification());

      expect(delivered).toBe(2);
      expect(JSON.parse(second.sent[1]).notification.title).toBe('Payout failed');
    });

    // Console sessions are always live (`livemodeOf`), so the crossing is exercised from the
    // other side: a test-mode notification must not reach a live socket.
    it('never crosses livemode — a test-mode notification skips a live socket', async () => {
      const socket = makeSocket();
      await gateway.handleConnection(socket as never, upgrade('pz_session=c; pz_csrf=t', 't'));

      expect(gateway.push(notification({ livemode: false }))).toBe(0);
    });

    it('returns 0 when the merchant has nothing open — not an error', () => {
      expect(gateway.push(notification({ merchant_id: 'mch_nobody' }))).toBe(0);
    });
  });

  it('answers a ping with a pong and drops an unknown frame', async () => {
    const socket = makeSocket();
    await gateway.handleConnection(socket as never, upgrade('pz_session=a; pz_csrf=t', 't'));

    socket.handlers.message(JSON.stringify({ kind: 'ping' }));
    socket.handlers.message('not json at all');

    const frames = socket.sent.slice(1).map((raw) => JSON.parse(raw));
    expect(frames[0].kind).toBe('pong');
    expect(frames[1]).toEqual({ kind: 'error', message: 'unrecognised frame' });
  });

  it('drops the subscriber on disconnect', async () => {
    const socket = makeSocket();
    await gateway.handleConnection(socket as never, upgrade('pz_session=a; pz_csrf=t', 't'));

    gateway.handleDisconnect(socket as never);

    expect(gateway.connectionCount()).toBe(0);
  });
});
