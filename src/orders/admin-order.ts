import { FulfillmentStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>;

/** What staff see. Contains customer details, so it is only ever returned behind the admin guard. */
export interface AdminOrder {
  id: string;
  orderNumber: number;
  createdAt: string;
  updatedAt: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  fulfillmentType: string;
  notes: string | null;
  fulfillmentStatus: FulfillmentStatus;
  paymentStatus: PaymentStatus;
  paymentReference: string | null;
  paymentReportedAt: string | null;
  cancelReason: string | null;
  acknowledgedAt: string | null;
  /** seq of the latest PAYMENT_REPORTED event: the id the hooter de-duplicates on. */
  alertSeq: string | null;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  items: { name: string; quantity: number; lineTotalCents: number }[];
}

export function toAdminOrder(o: OrderWithItems, alertSeq: bigint | null): AdminOrder {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    createdAt: o.createdAt.toISOString(),
    updatedAt: o.updatedAt.toISOString(),
    customerName: o.customerName,
    customerEmail: o.customerEmail,
    customerPhone: o.customerPhone,
    fulfillmentType: o.fulfillmentType,
    notes: o.notes,
    fulfillmentStatus: o.fulfillmentStatus,
    paymentStatus: o.paymentStatus,
    paymentReference: o.paymentReference,
    paymentReportedAt: o.paymentReportedAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    acknowledgedAt: o.acknowledgedAt?.toISOString() ?? null,
    alertSeq: alertSeq?.toString() ?? null,
    subtotalCents: o.subtotalCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    items: o.items.map((i) => ({ name: i.nameSnapshot, quantity: i.quantity, lineTotalCents: i.lineTotalCents })),
  };
}

export async function alertSeqs(prisma: PrismaService, orderIds: string[]): Promise<Map<string, bigint>> {
  if (orderIds.length === 0) return new Map();
  const rows = await prisma.orderEvent.groupBy({
    by: ['orderId'],
    where: { orderId: { in: orderIds }, type: 'PAYMENT_REPORTED' },
    _max: { seq: true },
  });
  return new Map(rows.flatMap((r) => (r._max.seq === null ? [] : [[r.orderId, r._max.seq] as const])));
}
