import { Injectable, Logger } from '@nestjs/common';
import { OrderEventType } from '@prisma/client';
import { Observable, Subject } from 'rxjs';
import { AdminOrder, alertSeqs, toAdminOrder } from '../orders/admin-order';
import { PrismaService } from '../prisma/prisma.service';

export interface LiveMessage {
  seq: string;
  eventId: string;
  type: OrderEventType;
  order: AdminOrder;
}

/**
 * In-process fan-out of order events to connected dashboards.
 * The OrderEvent table is the source of truth: publish() is only called AFTER the write has
 * committed, and clients reconcile from a database snapshot on every (re)connect, so a lost
 * message can never lose an order. A multi-instance deployment would swap the Subject for
 * Postgres LISTEN/NOTIFY or Redis pub/sub.
 */
@Injectable()
export class LiveEventsService {
  private readonly logger = new Logger(LiveEventsService.name);
  private readonly subject = new Subject<LiveMessage>();

  constructor(private readonly prisma: PrismaService) {}

  stream(): Observable<LiveMessage> {
    return this.subject.asObservable();
  }

  /** Never throws: a failed broadcast must not fail the request whose data is already saved. */
  async publish(eventId: string): Promise<void> {
    try {
      const event = await this.prisma.orderEvent.findUnique({ where: { id: eventId }, include: { order: { include: { items: true } } } });
      if (!event) return;
      const seqs = await alertSeqs(this.prisma, [event.orderId]);
      this.subject.next({ seq: event.seq.toString(), eventId: event.id, type: event.type, order: toAdminOrder(event.order, seqs.get(event.orderId) ?? null) });
    } catch (e) {
      this.logger.error(`Failed to publish event ${eventId}`, e instanceof Error ? e.stack : String(e));
    }
  }
}
