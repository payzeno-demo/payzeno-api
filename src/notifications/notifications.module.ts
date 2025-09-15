/**
 * NotificationsModule.
 *
 * Imports AuthModule for `SessionService` — the upgrade is authenticated with the same
 * session and the same CSRF double-submit as every mutating HTTP request — and EventsModule
 * for the SQS client and the `processed_event` claim. It owns the one long-poll loop that
 * lives outside `src/events/`, started here rather than by `EventsModule` because the
 * consumer depends on the gateway and the gateway depends on auth.
 */
import { Inject, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { CommonModule } from '../common/common.module';
import { PAYZENO_LOGGER, type PayzenoLogger } from '../common/logging/logger';
import { EventsModule } from '../events/events.module';

import { NotificationRelayConsumer } from './notification-relay.consumer';
import { NotificationsGateway } from './notifications.gateway';

@Module({
  imports: [CommonModule, EventsModule, AuthModule],
  providers: [NotificationsGateway, NotificationRelayConsumer],
  exports: [NotificationsGateway],
})
export class NotificationsModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly abort = new AbortController();
  private running: Promise<void> | null = null;

  constructor(
    private readonly relay: NotificationRelayConsumer,
    @Inject(PAYZENO_LOGGER) private readonly logger: PayzenoLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.running = this.relay.run(this.abort.signal).catch((err) => {
      this.logger.error('consumer.crashed', err, { consumer: this.relay.consumerName });
    });
    this.logger.info('notifications.relay_started', { queue_url: this.relay.queueUrl });
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    this.abort.abort();
    if (this.running) {
      await this.running;
    }
    this.logger.info('notifications.relay_stopped', { signal: signal ?? 'unknown' });
  }
}
