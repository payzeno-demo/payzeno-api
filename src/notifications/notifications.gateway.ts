/**
 * NotificationsGateway — `GET /ws/notifications`, api-surface.md §3.
 *
 * The server side of the console's `useNotificationStream()`. There is no separate gateway
 * service: payzeno-api owns the relay, `NotificationRelayConsumer` feeds it off the
 * `payzeno-console-notifications` queue, and this class fans out over the sockets.
 *
 * Auth on the upgrade is the ordinary session cookie plus the CSRF header — the same
 * double-submit as every mutating request, because an upgrade is a credentialed cross-origin
 * request and a socket that is opened by a third-party page is a tenant data leak that never
 * shows up in an access log. Once open, a socket is pinned to exactly one
 * `(merchant_id, livemode)` pair and receives nothing else.
 *
 * `ws`, not socket.io: the console uses the browser's native WebSocket and we do not want a
 * client library in the bundle for four message shapes.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';

import type { AuthPrincipal, MerchantId } from '@payzeno/contracts';

import { livemodeOf } from '../auth/principal/principal.factory';
import { SessionService } from '../auth/session/session.service';
import { AuthenticationRequiredException, PermissionDeniedException } from '../common/errors/auth.exceptions';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { CLOCK, type Clock } from '../common/time/clock';

import {
  parseClientFrame,
  type Notification,
  type ServerFrame,
} from './notification.types';

/** A socket plus the scope it was authenticated into. The scope is never re-read. */
interface Subscriber {
  socket: WebSocket;
  merchantId: MerchantId;
  livemode: boolean;
  userId: string;
  connectedAtMs: number;
}

const CSRF_HEADER = 'x-payzeno-csrf';
const SESSION_COOKIE = 'pz_session';
const CSRF_COOKIE = 'pz_csrf';

@Injectable()
@WebSocketGateway({ path: '/ws/notifications' })
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  /** merchant_id → sockets. One merchant routinely has several tabs open. */
  private readonly subscribers = new Map<MerchantId, Set<Subscriber>>();
  private readonly bySocket = new WeakMap<WebSocket, Subscriber>();

  constructor(
    private readonly sessions: SessionService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const cookies = parseCookies(request.headers.cookie ?? '');
    const sessionId = cookies[SESSION_COOKIE];
    const csrfCookie = cookies[CSRF_COOKIE];
    const csrfHeader = headerValue(request.headers[CSRF_HEADER]);

    if (!sessionId) {
      this.refuse(socket, 4401, 'authentication_required');
      return;
    }

    // Double-submit, identical to the HTTP path. A missing header is the interesting case:
    // it is what a cross-origin page can produce and a first-party console never can.
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      this.logger.warn('ws.csrf_rejected', {
        has_cookie: csrfCookie !== undefined,
        has_header: csrfHeader !== null,
      });
      this.refuse(socket, 4403, 'permission_denied');
      return;
    }

    // Also checks the header against the session record's own token, not only the cookie.
    let principal: AuthPrincipal;
    try {
      principal = await this.sessions.resolveForUpgrade(sessionId, csrfHeader);
    } catch (err) {
      if (err instanceof AuthenticationRequiredException) {
        this.refuse(socket, 4401, 'authentication_required');
        return;
      }
      if (err instanceof PermissionDeniedException) {
        this.refuse(socket, 4403, 'permission_denied');
        return;
      }
      throw err;
    }

    // A staff session carries no merchant, so there is no feed to pin the socket to.
    if (principal.kind !== 'dashboard_session') {
      this.refuse(socket, 4403, 'permission_denied');
      return;
    }

    const subscriber: Subscriber = {
      socket,
      merchantId: principal.merchant_id,
      livemode: livemodeOf(principal),
      userId: principal.user_id,
      connectedAtMs: this.clock.nowMs(),
    };

    this.register(subscriber);
    socket.on('message', (data: unknown) => this.onMessage(subscriber, String(data)));

    this.send(socket, {
      kind: 'ready',
      merchant_id: subscriber.merchantId,
      livemode: subscriber.livemode,
    });

    this.logger.info('ws.connected', {
      merchant_id: subscriber.merchantId,
      user_id: subscriber.userId,
      livemode: subscriber.livemode,
      sockets_for_merchant: this.subscribers.get(subscriber.merchantId)?.size ?? 1,
    });
  }

  handleDisconnect(socket: WebSocket): void {
    const subscriber = this.bySocket.get(socket);
    if (!subscriber) {
      return;
    }

    const set = this.subscribers.get(subscriber.merchantId);
    set?.delete(subscriber);
    if (set && set.size === 0) {
      this.subscribers.delete(subscriber.merchantId);
    }
    this.bySocket.delete(socket);

    this.logger.info('ws.disconnected', {
      merchant_id: subscriber.merchantId,
      user_id: subscriber.userId,
      held_ms: this.clock.nowMs() - subscriber.connectedAtMs,
    });
  }

  /**
   * `NotificationRelayConsumer` calls this and nothing else does. Returns the number of
   * sockets written to, which the consumer logs — zero is normal (nobody has the console
   * open) and is deliberately not an error.
   */
  push(notification: Notification): number {
    const set = this.subscribers.get(notification.merchant_id);
    if (!set || set.size === 0) {
      return 0;
    }

    let delivered = 0;
    for (const subscriber of set) {
      // A live-mode notification must never surface on a test-mode socket. Same rule as
      // every merchant-scoped read; the socket is scoped once and forever.
      if (subscriber.livemode !== notification.livemode) {
        continue;
      }
      if (this.send(subscriber.socket, { kind: 'notification', notification })) {
        delivered += 1;
      }
    }
    return delivered;
  }

  /** Ops surface: how many consoles are attached right now. Read by `/readyz`. */
  connectionCount(): number {
    let total = 0;
    for (const set of this.subscribers.values()) {
      total += set.size;
    }
    return total;
  }

  private onMessage(subscriber: Subscriber, raw: string): void {
    const frame = parseClientFrame(raw);

    if (!frame) {
      this.send(subscriber.socket, { kind: 'error', message: 'unrecognised frame' });
      return;
    }

    if (frame.kind === 'ping') {
      this.send(subscriber.socket, { kind: 'pong', at: this.clock.nowIso() });
      return;
    }

    // `ack` is advisory. Delivery is best-effort by design: the console re-reads the REST
    // endpoints on focus, so a dropped frame costs a render, not a fact.
    this.logger.debug('ws.ack', {
      merchant_id: subscriber.merchantId,
      notification_id: frame.id,
    });
  }

  private register(subscriber: Subscriber): void {
    const existing = this.subscribers.get(subscriber.merchantId) ?? new Set<Subscriber>();
    existing.add(subscriber);
    this.subscribers.set(subscriber.merchantId, existing);
    this.bySocket.set(subscriber.socket, subscriber);
  }

  private refuse(socket: WebSocket, code: number, reason: string): void {
    this.send(socket, { kind: 'error', message: reason });
    socket.close(code, reason);
  }

  private send(socket: WebSocket, frame: ServerFrame): boolean {
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      this.logger.error('ws.send_failed', err, { frame_kind: frame.kind });
      return false;
    }
  }
}

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) {
      continue;
    }
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}
