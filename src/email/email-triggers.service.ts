import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subscription } from 'rxjs';
import { LiveEventsService, LiveMessage } from '../live/live-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from './email.service';
import { OrderCtx, TemplateName, renderOrderEmail } from './email.templates';

/** Which customer-facing email, if any, a committed order event should produce. */
export function templateFor(type: string, data: unknown): Exclude<TemplateName, 'password_reset'> | null {
  switch (type) {
    case 'ORDER_CREATED': return 'order_received';
    case 'PAYMENT_VERIFIED': return 'payment_confirmed';
    case 'PAYMENT_REJECTED': return 'payment_not_received';
    case 'ORDER_CANCELLED': return 'order_cancelled'; // also covers the refund: one email, not two
    case 'STATUS_CHANGED': {
      const to = (data as { to?: string } | null)?.to;
      return to === 'ACCEPTED' ? 'order_accepted' : to === 'READY' ? 'order_ready' : null; // preparing/completed stay quiet
    }
    default: return null; // e.g. the customer's own "I've paid" and staff acknowledgements
  }
}

/**
 * Listens to the same committed-event stream as the live dashboard, so emails are only ever
 * sent for changes that really happened, and never delay the request that caused them.
 */
@Injectable()
export class EmailTriggers implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailTriggers.name);
  private sub?: Subscription;

  constructor(
    private readonly live: LiveEventsService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    this.sub = this.live.stream().subscribe((m) => void this.handle(m).catch((e: unknown) => this.logger.error(`Could not queue email for event ${m.eventId}`, e instanceof Error ? e.stack : String(e))));
  }
  onModuleDestroy(): void {
    this.sub?.unsubscribe();
  }

  async handle(m: LiveMessage): Promise<void> {
    const event = await this.prisma.orderEvent.findUnique({ where: { id: m.eventId } });
    if (!event) return;
    const template = templateFor(event.type, event.data);
    if (!template) return;

    const [order, settings] = await Promise.all([
      this.prisma.order.findUnique({ where: { id: event.orderId }, include: { items: true } }),
      this.prisma.siteSettings.findUnique({ where: { id: 'singleton' } }),
    ]);
    if (!order) return;

    const ctx: OrderCtx = {
      restaurantName: settings?.restaurantName ?? 'Shree Foods',
      restaurantPhone: settings?.phone ?? null,
      restaurantAddress: settings?.address ?? null,
      customerName: order.customerName,
      orderNumber: order.orderNumber,
      items: order.items.map((i) => ({ name: i.nameSnapshot, quantity: i.quantity, lineTotalCents: i.lineTotalCents })),
      subtotalCents: order.subtotalCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
      statusUrl: `${this.config.getOrThrow<string>('FRONTEND_URL')}/order/${order.publicToken}`,
      fulfillmentType: order.fulfillmentType,
      cancelReason: order.cancelReason,
      refunded: order.paymentStatus === 'REFUNDED',
    };
    await this.email.enqueue({
      template,
      to: order.customerEmail,
      orderId: order.id,
      dedupeKey: `${event.id}:${template}`, // one email per event, however many times the event is replayed
      message: { to: order.customerEmail, ...renderOrderEmail(template, ctx) },
    });
  }
}
