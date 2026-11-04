import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { FulfillmentStatus, OrderEventType, PaymentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthedAdmin } from '../auth/auth.types';
import { LiveEventsService } from '../live/live-events.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminOrder, alertSeqs, toAdminOrder } from './admin-order';
import { canTransitionFulfillment, canTransitionPayment } from './order-state';

export const statusSchema = z.object({ status: z.enum(['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) });
export const rejectPaymentSchema = z.object({ reason: z.string().trim().max(200).optional() });
export const cancelSchema = z.object({
  reason: z.string().trim().min(3, 'Give a short reason').max(200),
  /** Must be true to cancel an order whose payment was verified: staff confirm the money went back. */
  refundIssued: z.boolean().default(false),
});
export type StatusInput = z.infer<typeof statusSchema>;
export type RejectPaymentInput = z.infer<typeof rejectPaymentSchema>;
export type CancelInput = z.infer<typeof cancelSchema>;

interface Change {
  /** The order must still be in one of these states for the write to apply (race-safe). */
  whenPayment: PaymentStatus[];
  whenFulfillment: FulfillmentStatus[];
  data: Prisma.OrderUpdateManyMutationInput;
  events: { type: OrderEventType; data?: Prisma.InputJsonValue }[];
  verifiedBy?: string;
}

/**
 * Every staff mutation lives here. Rules enforced on the server, never trusted from the UI:
 *  - payment can only become PAID by staff verifying an AWAITING_VERIFICATION order
 *  - an order can't be accepted or progressed until its payment is PAID
 *  - transitions follow order-state.ts; repeated identical requests are harmless no-ops
 *  - events are broadcast only after the database write has committed
 */
@Injectable()
export class OrderActionsService {
  private readonly logger = new Logger(OrderActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveEventsService,
  ) {}

  async verifyPayment(id: string, admin: AuthedAdmin): Promise<AdminOrder> {
    const o = await this.load(id);
    if (o.paymentStatus === 'PAID') return this.view(id); // idempotent
    if (o.fulfillmentStatus === 'CANCELLED') throw new ConflictException('This order was cancelled');
    if (o.paymentStatus !== 'AWAITING_VERIFICATION' || !canTransitionPayment(o.paymentStatus, 'PAID')) {
      throw new ConflictException('The customer hasn’t reported a payment for this order yet');
    }
    return this.apply(id, admin, {
      whenPayment: ['AWAITING_VERIFICATION'],
      whenFulfillment: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'],
      data: { paymentStatus: 'PAID', paymentVerifiedAt: new Date() },
      verifiedBy: admin.id,
      events: [{ type: 'PAYMENT_VERIFIED' }],
    });
  }

  async rejectPayment(id: string, admin: AuthedAdmin, input: RejectPaymentInput): Promise<AdminOrder> {
    const o = await this.load(id);
    if (o.paymentStatus === 'FAILED') return this.view(id);
    if (o.paymentStatus !== 'AWAITING_VERIFICATION' || !canTransitionPayment(o.paymentStatus, 'FAILED')) {
      throw new ConflictException('There is no reported payment to reject');
    }
    return this.apply(id, admin, {
      whenPayment: ['AWAITING_VERIFICATION'],
      whenFulfillment: ['PENDING_ACCEPTANCE', 'ACCEPTED', 'PREPARING', 'READY'],
      data: { paymentStatus: 'FAILED', acknowledgedAt: o.acknowledgedAt ?? new Date() },
      events: [{ type: 'PAYMENT_REJECTED', data: input.reason ? { reason: input.reason } : undefined }],
    });
  }

  async setStatus(id: string, admin: AuthedAdmin, { status }: StatusInput): Promise<AdminOrder> {
    const o = await this.load(id);
    if (o.fulfillmentStatus === status) return this.view(id); // idempotent
    if (!canTransitionFulfillment(o.fulfillmentStatus, status)) {
      throw new ConflictException(`An order that is ${o.fulfillmentStatus.toLowerCase().replaceAll('_', ' ')} can’t move to ${status.toLowerCase()}`);
    }
    if (o.paymentStatus !== 'PAID') throw new ConflictException('Verify the payment before working on this order');
    return this.apply(id, admin, {
      whenPayment: ['PAID'],
      whenFulfillment: [o.fulfillmentStatus],
      data: { fulfillmentStatus: status, acknowledgedAt: o.acknowledgedAt ?? new Date() }, // acting on it implies it was seen
      events: [{ type: 'STATUS_CHANGED', data: { from: o.fulfillmentStatus, to: status } }],
    });
  }

  async cancel(id: string, admin: AuthedAdmin, input: CancelInput): Promise<AdminOrder> {
    const o = await this.load(id);
    if (o.fulfillmentStatus === 'CANCELLED') return this.view(id);
    if (!canTransitionFulfillment(o.fulfillmentStatus, 'CANCELLED')) throw new ConflictException('A completed order can’t be cancelled');

    const events: Change['events'] = [{ type: 'ORDER_CANCELLED', data: { reason: input.reason } }];
    let paymentStatus: PaymentStatus = o.paymentStatus;
    if (o.paymentStatus === 'PAID') {
      // Refund policy: money that was verified must be returned before the order can be cancelled.
      if (!input.refundIssued) throw new ConflictException('This order is paid. Confirm that you have refunded the customer to cancel it.');
      paymentStatus = 'REFUNDED';
      events.push({ type: 'PAYMENT_REFUNDED' });
    } else if (o.paymentStatus === 'AWAITING_VERIFICATION') {
      paymentStatus = 'FAILED'; // staff did not receive the money; if they did, verify it first and refund
    }
    return this.apply(id, admin, {
      whenPayment: [o.paymentStatus],
      whenFulfillment: [o.fulfillmentStatus],
      data: { fulfillmentStatus: 'CANCELLED', paymentStatus, cancelReason: input.reason, acknowledgedAt: o.acknowledgedAt ?? new Date() },
      events,
    });
  }

  async acknowledge(id: string, admin: AuthedAdmin): Promise<AdminOrder> {
    const o = await this.load(id);
    if (o.acknowledgedAt) return this.view(id);
    const { count } = await this.prisma.order.updateMany({ where: { id, acknowledgedAt: null }, data: { acknowledgedAt: new Date() } });
    if (count === 1) {
      const ev = await this.prisma.orderEvent.create({ data: { orderId: id, type: 'ALERT_ACKNOWLEDGED', actorId: admin.id } });
      await this.live.publish(ev.id);
    }
    return this.view(id);
  }

  // ---- internals ----

  private async load(id: string) {
    const o = await this.prisma.order.findUnique({ where: { id } });
    if (!o) throw new NotFoundException('Order not found');
    return o;
  }

  private async view(id: string): Promise<AdminOrder> {
    const o = await this.prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true } });
    const seqs = await alertSeqs(this.prisma, [id]);
    return toAdminOrder(o, seqs.get(id) ?? null);
  }

  /** Conditional write + audit events in one transaction, then broadcast after it commits. */
  private async apply(id: string, admin: AuthedAdmin, change: Change): Promise<AdminOrder> {
    const eventIds = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id, paymentStatus: { in: change.whenPayment }, fulfillmentStatus: { in: change.whenFulfillment } },
        data: { ...change.data, ...(change.verifiedBy && { paymentVerifiedBy: change.verifiedBy }) },
      });
      if (count !== 1) return null;
      const ids: string[] = [];
      for (const e of change.events) {
        const ev = await tx.orderEvent.create({ data: { orderId: id, type: e.type, actorId: admin.id, data: e.data } });
        ids.push(ev.id);
      }
      return ids;
    });

    if (!eventIds) {
      // Lost a race with another staff member.
      this.logger.warn(`Order ${id}: concurrent change, ${change.events[0]?.type} not applied`);
      throw new ConflictException('This order was just changed by someone else. Refreshing.');
    }
    for (const eventId of eventIds) await this.live.publish(eventId); // only after the commit
    return this.view(id);
  }
}
