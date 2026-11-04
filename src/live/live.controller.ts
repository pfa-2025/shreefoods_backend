import { Controller, Get, Header, MessageEvent, Sse, UseGuards } from '@nestjs/common';
import { OrderEvent } from '@prisma/client';
import { Observable, interval, map, merge, of } from 'rxjs';
import { AdminAuthGuard } from '../auth/auth.guard';
import { AdminOrder, alertSeqs, toAdminOrder } from '../orders/admin-order';
import { PrismaService } from '../prisma/prisma.service';
import { LiveEventsService } from './live-events.service';

const ACTIVE = ['PENDING_ACCEPTANCE', 'ACCEPTED', 'PREPARING', 'READY'] as const;
const FINISHED_WINDOW_MS = 24 * 3_600_000;

/** Authenticated like every other admin route: the session cookie is checked before the stream opens. */
@Controller('admin/live')
@UseGuards(AdminAuthGuard)
export class LiveController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly live: LiveEventsService,
  ) {}

  /**
   * Authoritative state straight from the database. Clients call this on load and after every
   * reconnect, so orders that arrived while disconnected are recovered and nothing is duplicated
   * (rows are keyed by order id).
   */
  @Get('snapshot')
  async snapshot(): Promise<{ orders: AdminOrder[]; latestSeq: string; serverTime: string }> {
    const [rows, last] = await Promise.all([
      this.prisma.order.findMany({
        where: { OR: [{ fulfillmentStatus: { in: [...ACTIVE] } }, { updatedAt: { gt: new Date(Date.now() - FINISHED_WINDOW_MS) } }] },
        orderBy: { createdAt: 'asc' },
        include: { items: true },
        take: 500,
      }),
      this.prisma.orderEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } }),
    ]);
    const seqs = await alertSeqs(this.prisma, rows.map((r) => r.id));
    return {
      orders: rows.map((r) => toAdminOrder(r, seqs.get(r.id) ?? null)),
      latestSeq: (last?.seq ?? 0n).toString(),
      serverTime: new Date().toISOString(),
    };
  }

  /** Server-Sent Events. `id` is the event's database seq. A ping every 25s keeps proxies from closing it. */
  @Sse('stream')
  @Header('Cache-Control', 'no-cache, no-transform')
  @Header('X-Accel-Buffering', 'no')
  stream(): Observable<MessageEvent> {
    return merge(
      of<MessageEvent>({ type: 'ready', data: { ok: true } }),
      this.live.stream().pipe(map((m): MessageEvent => ({ id: m.seq, type: 'order', data: m }))),
      interval(25_000).pipe(map((): MessageEvent => ({ type: 'ping', data: { t: Date.now() } }))),
    );
  }
}

export type { OrderEvent };
