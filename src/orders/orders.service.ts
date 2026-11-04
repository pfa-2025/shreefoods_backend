import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FulfillmentStatus, PaymentStatus, Prisma } from '@prisma/client';
import { CartService } from '../cart/cart.service';
import { OwnReview, REVIEWABLE, toOwnReview } from '../reviews/reviews.service';
import { EmailProvider } from '../email/email.provider';
import { LiveEventsService } from '../live/live-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { customerCanReportPayment } from './order-state';
import { CreateOrderInput, ReportPaymentInput } from './orders.schemas';

export interface PublicOrder {
  orderNumber: number;
  createdAt: string;
  restaurantName: string;
  fulfillmentType: 'PICKUP' | 'DINE_IN' | 'DELIVERY';
  fulfillmentStatus: FulfillmentStatus;
  paymentStatus: PaymentStatus;
  paymentReference: string | null;
  cancelReason: string | null;
  items: { name: string; quantity: number; unitPriceCents: number; lineTotalCents: number }[];
  subtotalCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
  /** True once the order is ready and has not been reviewed yet. */
  canReview: boolean;
  /** The customer's own review of this order, if they wrote one. */
  review: OwnReview | null;
  /** True when real emails are being sent (false in development log-only mode). */
  emailsEnabled: boolean;
  /** Present only while the customer still needs to pay. */
  payment: { qrUrl: string | null; qrAlt: string; handle: string | null; instructions: string } | null;
}

const orderInclude = { items: true, review: true } satisfies Prisma.OrderInclude;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly live: LiveEventsService,
    private readonly emailProvider: EmailProvider,
  ) {}

  async create(input: CreateOrderInput): Promise<{ token: string; orderNumber: number }> {
    // Same key => same order. Makes double-clicks and retries after a network error safe.
    const existing = await this.prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) return { token: existing.publicToken, orderNumber: existing.orderNumber };

    const settings = await this.prisma.siteSettings.findUnique({ where: { id: 'singleton' } });
    const enabled = {
      PICKUP: settings?.pickupEnabled ?? true,
      DINE_IN: settings?.dineInEnabled ?? false,
      DELIVERY: settings?.deliveryEnabled ?? false,
    };
    if (!enabled[input.fulfillmentType]) {
      throw new UnprocessableEntityException('That order type is not available right now');
    }

    // The server is the only source of prices; the client sent ids and quantities.
    const quote = await this.cart.quote({ items: input.items });
    if (!quote.ordersOpen) throw new ConflictException('Online ordering is currently closed');
    if (quote.issues.length > 0 || quote.lines.length === 0) {
      throw new HttpException(
        { message: 'Some items in your cart are no longer available', details: quote.issues },
        409,
      );
    }

    try {
      // One nested create is a single atomic write: order + item snapshots + audit event.
      const order = await this.prisma.order.create({
        data: {
          publicToken: randomBytes(24).toString('base64url'),
          idempotencyKey: input.idempotencyKey,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          fulfillmentType: input.fulfillmentType,
          deliveryAddress: input.deliveryAddress,
          notes: input.notes,
          subtotalCents: quote.subtotalCents,
          taxCents: quote.taxCents,
          feeCents: quote.feeCents,
          totalCents: quote.totalCents,
          items: {
            create: quote.lines.map((l) => ({
              menuItemId: l.menuItemId,
              nameSnapshot: l.name,
              unitPriceCents: l.unitPriceCents,
              quantity: l.quantity,
              lineTotalCents: l.lineTotalCents,
            })),
          },
          events: { create: { type: 'ORDER_CREATED' } },
        },
      });
      this.logger.log(`Order #${order.orderNumber} created (${order.totalCents} cents)`);
      const created = await this.prisma.orderEvent.findFirst({ where: { orderId: order.id, type: 'ORDER_CREATED' } });
      if (created) await this.live.publish(created.id); // after the write committed
      return { token: order.publicToken, orderNumber: order.orderNumber };
    } catch (e) {
      // Two simultaneous submits with the same key: the loser returns the winner's order.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
        if (winner) return { token: winner.publicToken, orderNumber: winner.orderNumber };
      }
      throw e;
    }
  }

  async getByToken(token: string): Promise<PublicOrder> {
    const order = await this.prisma.order.findUnique({ where: { publicToken: token }, include: orderInclude });
    if (!order) throw new NotFoundException('Order not found');
    const settings = await this.prisma.siteSettings.findUnique({
      where: { id: 'singleton' },
      include: { paymentQr: true },
    });

    const needsPayment =
      order.fulfillmentStatus !== 'CANCELLED' &&
      (order.paymentStatus === 'UNPAID' || order.paymentStatus === 'FAILED' || order.paymentStatus === 'AWAITING_VERIFICATION');

    // Deliberately omits name, email, phone, address and notes: this endpoint is link-based, not login-based.
    return {
      orderNumber: order.orderNumber,
      createdAt: order.createdAt.toISOString(),
      restaurantName: settings?.restaurantName ?? 'Shree Foods',
      fulfillmentType: order.fulfillmentType,
      fulfillmentStatus: order.fulfillmentStatus,
      paymentStatus: order.paymentStatus,
      paymentReference: order.paymentReference,
      cancelReason: order.cancelReason,
      items: order.items.map((i) => ({
        name: i.nameSnapshot,
        quantity: i.quantity,
        unitPriceCents: i.unitPriceCents,
        lineTotalCents: i.lineTotalCents,
      })),
      subtotalCents: order.subtotalCents,
      taxCents: order.taxCents,
      feeCents: order.feeCents,
      totalCents: order.totalCents,
      canReview: !order.review && (REVIEWABLE as readonly string[]).includes(order.fulfillmentStatus),
      review: order.review ? toOwnReview(order.review) : null,
      emailsEnabled: this.emailProvider.name === 'resend',
      payment: needsPayment
        ? {
            qrUrl: settings?.paymentQr?.url ?? null,
            qrAlt: settings?.paymentQr?.altText ?? 'Payment QR code',
            handle: settings?.paymentHandle ?? null,
            instructions: settings?.paymentInstructions ?? '',
          }
        : null,
    };
  }

  /**
   * The customer says they paid. This does NOT mark the order paid: it asks staff to verify.
   * Idempotent: repeating the call changes nothing.
   */
  async reportPayment(token: string, input: ReportPaymentInput): Promise<PublicOrder> {
    const order = await this.prisma.order.findUnique({ where: { publicToken: token } });
    if (!order) throw new NotFoundException('Order not found');

    if (order.paymentStatus === 'AWAITING_VERIFICATION' || order.paymentStatus === 'PAID') {
      return this.getByToken(token);
    }
    if (!customerCanReportPayment(order.paymentStatus, order.fulfillmentStatus)) {
      throw new ConflictException('Payment can’t be reported for this order');
    }

    // Conditional update guards against a concurrent change (e.g. staff verifying at the same moment).
    const { count } = await this.prisma.order.updateMany({
      where: { id: order.id, paymentStatus: order.paymentStatus, fulfillmentStatus: { not: 'CANCELLED' } },
      data: {
        paymentStatus: 'AWAITING_VERIFICATION',
        paymentReference: input.reference ?? order.paymentReference,
        paymentReportedAt: new Date(),
        acknowledgedAt: null, // a fresh report needs fresh attention (and a fresh hooter)
      },
    });
    if (count === 1) {
      const ev = await this.prisma.orderEvent.create({
        data: { orderId: order.id, type: 'PAYMENT_REPORTED', data: input.reference ? { reference: input.reference } : undefined },
      });
      await this.live.publish(ev.id); // after the write committed
      this.logger.log(`Order #${order.orderNumber} payment reported, awaiting staff verification`);
    }
    return this.getByToken(token);
  }
}
