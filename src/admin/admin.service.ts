import { BadRequestException, Injectable } from '@nestjs/common';
import { FulfillmentStatus, OrderEventType, PaymentStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthedAdmin } from '../auth/auth.types';
import { AdminOrder, alertSeqs, toAdminOrder } from '../orders/admin-order';
import { PrismaService } from '../prisma/prisma.service';

const MAX_RANGE_MS = 366 * 24 * 3_600_000;
const isoDate = z.string().datetime({ offset: true });

const rangeShape = { from: isoDate.optional(), to: isoDate.optional() };
const rangeCheck = (v: { from?: string; to?: string }) =>
  !v.from || !v.to || (new Date(v.to).getTime() > new Date(v.from).getTime() && new Date(v.to).getTime() - new Date(v.from).getTime() <= MAX_RANGE_MS);
const rangeMsg = { message: 'Date range must be positive and at most one year', path: ['to'] };

export const dashboardQuerySchema = z.object(rangeShape).refine(rangeCheck, rangeMsg);
const ordersFilterShape = {
  ...rangeShape,
  status: z.enum(['PENDING_ACCEPTANCE', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED']).optional(),
  payment: z.enum(['UNPAID', 'AWAITING_VERIFICATION', 'PAID', 'FAILED', 'REFUNDED']).optional(),
  q: z.string().max(200).transform((v) => v.replaceAll('\u0000', '').trim().slice(0, 100)).optional(), // Postgres rejects NUL bytes
};
export const ordersQuerySchema = z
  .object({ ...ordersFilterShape, page: z.coerce.number().int().min(1).max(10_000).default(1) })
  .refine(rangeCheck, rangeMsg);

const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};
/** Same filters as the orders list, plus the viewer's time zone so times in the spreadsheet match what they see on screen. */
export const exportQuerySchema = z
  .object({ ...ordersFilterShape, tz: z.string().max(64).refine(validTimeZone, 'Unknown time zone').default('UTC') })
  .refine(rangeCheck, rangeMsg);
export type ExportQuery = z.infer<typeof exportQuerySchema>;
/** A safety cap so one click can't try to build an enormous file. */
export const EXPORT_MAX_ORDERS = 20_000;
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
export type OrdersQuery = z.infer<typeof ordersQuerySchema>;

const PAGE_SIZE = 25;
const ACTIVE: FulfillmentStatus[] = ['PENDING_ACCEPTANCE', 'ACCEPTED', 'PREPARING', 'READY'];

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  private createdRange(q: { from?: string; to?: string }): Prisma.OrderWhereInput {
    if (!q.from && !q.to) return {};
    return { createdAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lt: new Date(q.to) }) } };
  }

  async dashboard(admin: AuthedAdmin, q: DashboardQuery) {
    const inRange = this.createdRange(q);
    const isOwner = admin.role === 'OWNER';

    const [queue, awaitingVerification, ordersInRange, completedInRange, revenue, events, pendingReviews] = await Promise.all([
      this.prisma.order.groupBy({ by: ['fulfillmentStatus'], where: { fulfillmentStatus: { in: ACTIVE } }, _count: true }),
      this.prisma.order.count({ where: { paymentStatus: 'AWAITING_VERIFICATION', fulfillmentStatus: { not: 'CANCELLED' } } }),
      this.prisma.order.count({ where: inRange }),
      this.prisma.order.count({ where: { ...inRange, fulfillmentStatus: 'COMPLETED' } }),
      // Revenue is only ever counted from staff-verified payments.
      isOwner
        ? this.prisma.order.aggregate({
            where: {
              paymentStatus: 'PAID',
              ...(q.from || q.to
                ? { paymentVerifiedAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lt: new Date(q.to) }) } }
                : {}),
            },
            _sum: { totalCents: true },
            _count: true,
          })
        : Promise.resolve(null),
      this.prisma.orderEvent.findMany({ orderBy: { seq: 'desc' }, take: 15, include: { order: { select: { orderNumber: true } } } }),
      this.prisma.review.count({ where: { status: 'PENDING' } }),
    ]);

    const count = (s: FulfillmentStatus) => queue.find((r) => r.fulfillmentStatus === s)?._count ?? 0;
    return {
      queue: {
        pendingAcceptance: count('PENDING_ACCEPTANCE'),
        accepted: count('ACCEPTED'),
        preparing: count('PREPARING'),
        ready: count('READY'),
        awaitingPaymentVerification: awaitingVerification,
        reviewsToModerate: pendingReviews,
      },
      range: {
        orders: ordersInRange,
        completed: completedInRange,
        revenueCents: revenue ? (revenue._sum.totalCents ?? 0) : null, // null = not permitted for this role
        paidOrders: revenue ? revenue._count : null,
      },
      recentActivity: events.map((e: { id: string; type: OrderEventType; createdAt: Date; order: { orderNumber: number } }) => ({
        id: e.id,
        type: e.type,
        createdAt: e.createdAt.toISOString(),
        orderNumber: e.order.orderNumber,
      })),
    };
  }

  /** The filters shared by the orders list and the Excel export. */
  private ordersWhere(q: { from?: string; to?: string; status?: FulfillmentStatus; payment?: PaymentStatus; q?: string }): Prisma.OrderWhereInput {
    const term = q.q ?? '';
    const orderRef = term.replace(/^sf-?/i, '');
    const digits = term.replace(/\D/g, '');
    return {
      ...this.createdRange(q),
      ...(q.status && { fulfillmentStatus: q.status }),
      ...(q.payment && { paymentStatus: q.payment }),
      ...(term && {
        OR: [
          ...(/^\d{1,9}$/.test(orderRef) ? [{ orderNumber: Number(orderRef) }] : []),
          { customerName: { contains: term, mode: 'insensitive' as const } },
          { customerEmail: { contains: term, mode: 'insensitive' as const } },
          ...(digits ? [{ customerPhone: { contains: digits } }] : []),
        ],
      }),
    };
  }

  /** Every order matching the filters (newest first, with items) for the spreadsheet. Refuses absurdly large exports. */
  async ordersForExport(q: ExportQuery) {
    const where = this.ordersWhere(q);
    const count = await this.prisma.order.count({ where });
    if (count > EXPORT_MAX_ORDERS) {
      throw new BadRequestException(`That is ${count} orders, which is too many for one file (limit ${EXPORT_MAX_ORDERS}). Choose a shorter date range.`);
    }
    return this.prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, include: { items: true } });
  }

  async orders(q: OrdersQuery): Promise<{ orders: AdminOrder[]; total: number; page: number; pageSize: number }> {
    const where = this.ordersWhere(q);
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
        include: { items: true },
      }),
    ]);
    const seqs = await alertSeqs(this.prisma, rows.map((r) => r.id));
    return {
      total,
      page: q.page,
      pageSize: PAGE_SIZE,
      orders: rows.map((o) => toAdminOrder(o, seqs.get(o.id) ?? null)),
    };
  }
}
