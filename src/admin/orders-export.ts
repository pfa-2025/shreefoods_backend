import { FulfillmentStatus, PaymentStatus, Prisma } from '@prisma/client';
import writeExcelFile from 'write-excel-file/node';

type OrderRow = Prisma.OrderGetPayload<{ include: { items: true } }>;

export interface ExportMeta {
  tz: string;
  generatedAt: Date;
  filters: { from?: string; to?: string; status?: string; payment?: string; q?: string };
}

const MONEY = '[$$-409]#,##0.00';
const DATETIME = 'yyyy-mm-dd hh:mm';

const FULFILLMENT: Record<FulfillmentStatus, string> = {
  PENDING_ACCEPTANCE: 'Awaiting acceptance', ACCEPTED: 'Accepted', PREPARING: 'Preparing', READY: 'Ready', COMPLETED: 'Completed', CANCELLED: 'Cancelled',
};
const PAYMENT: Record<PaymentStatus, string> = {
  UNPAID: 'Unpaid', AWAITING_VERIFICATION: 'Awaiting verification', PAID: 'Paid', FAILED: 'Payment not received', REFUNDED: 'Refunded',
};
const TYPE: Record<string, string> = { PICKUP: 'Pickup', DINE_IN: 'Dine-in', DELIVERY: 'Delivery' };

export const orderRef = (n: number): string => `SF-${String(n).padStart(4, '0')}`;
const dollars = (cents: number): number => Math.round(cents) / 100;

/**
 * Excel stores a date with no time zone, so shift the instant to the viewer's wall-clock time:
 * an order placed at 9:00 PM New York time reads 9:00 PM in the sheet, not 2:00 AM UTC.
 */
export function wallClock(date: Date, tz: string): Date {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)));
}

// Every piece of customer-supplied text is written as an explicit *text* cell. Only a cell explicitly typed as a
// formula is ever calculated, so a name or note like =HYPERLINK(...) or +cmd|... is shown literally, never run.
const text = (v: string | null | undefined) => (v ? { value: v, type: String } : null);
const head = (v: string) => ({ value: v, type: String, fontWeight: 'bold' as const, backgroundColor: '#E3EBE5' });
const money = (cents: number) => ({ value: dollars(cents), type: Number, format: MONEY });
const when = (d: Date | null | undefined, tz: string) => (d ? { value: wallClock(d, tz), type: Date, format: DATETIME } : null);

export async function buildOrdersWorkbook(orders: OrderRow[], meta: ExportMeta): Promise<Buffer> {
  const { tz } = meta;

  const orderRows = [
    ['Order', 'Placed', 'Customer', 'Email', 'Phone', 'Order type', 'Items', 'Notes', 'Subtotal', 'Tax', 'Total', 'Payment', 'Payment reference', 'Payment verified', 'Order status', 'Cancellation reason'].map(head),
    ...orders.map((o) => [
      text(orderRef(o.orderNumber)),
      when(o.createdAt, tz),
      text(o.customerName),
      text(o.customerEmail),
      text(o.customerPhone),
      text(TYPE[o.fulfillmentType] ?? o.fulfillmentType),
      text(o.items.map((i) => `${i.quantity} × ${i.nameSnapshot}`).join('; ')),
      text(o.notes),
      money(o.subtotalCents),
      money(o.taxCents),
      money(o.totalCents),
      text(PAYMENT[o.paymentStatus]),
      text(o.paymentReference),
      when(o.paymentVerifiedAt, tz),
      text(FULFILLMENT[o.fulfillmentStatus]),
      text(o.cancelReason),
    ]),
  ];

  const itemRows = [
    ['Order', 'Placed', 'Customer', 'Item', 'Quantity', 'Unit price', 'Line total', 'Order status', 'Payment'].map(head),
    ...orders.flatMap((o) =>
      o.items.map((i) => [
        text(orderRef(o.orderNumber)),
        when(o.createdAt, tz),
        text(o.customerName),
        text(i.nameSnapshot),
        { value: i.quantity, type: Number },
        money(i.unitPriceCents),
        money(i.lineTotalCents),
        text(FULFILLMENT[o.fulfillmentStatus]),
        text(PAYMENT[o.paymentStatus]),
      ]),
    ),
  ];

  // Money is counted exactly like the dashboard: only payments staff verified (PAID) count as revenue.
  const paid = orders.filter((o) => o.paymentStatus === 'PAID');
  const revenueCents = paid.reduce((sum, o) => sum + o.totalCents, 0);
  const f = meta.filters;
  const kv = (k: string, v: ReturnType<typeof text> | ReturnType<typeof money> | { value: number; type: NumberConstructor } | ReturnType<typeof when>) => [{ value: k, type: String, fontWeight: 'bold' as const }, v];
  const summaryRows = [
    kv('Generated', when(meta.generatedAt, tz)),
    kv('Time zone', text(tz)),
    kv('From', text(f.from ? wallClock(new Date(f.from), tz).toISOString().slice(0, 10) : 'Beginning')),
    kv('To (before)', text(f.to ? wallClock(new Date(f.to), tz).toISOString().slice(0, 10) : 'Now')),
    kv('Order status filter', text(f.status ? FULFILLMENT[f.status as FulfillmentStatus] : 'All')),
    kv('Payment filter', text(f.payment ? PAYMENT[f.payment as PaymentStatus] : 'All')),
    kv('Search', text(f.q || 'None')),
    [null, null],
    kv('Orders in this file', { value: orders.length, type: Number }),
    kv('Paid orders (verified)', { value: paid.length, type: Number }),
    kv('Revenue (verified payments)', money(revenueCents)),
    kv('Refunded orders', { value: orders.filter((o) => o.paymentStatus === 'REFUNDED').length, type: Number }),
    kv('Cancelled orders', { value: orders.filter((o) => o.fulfillmentStatus === 'CANCELLED').length, type: Number }),
    [null, null],
    [{ value: 'Revenue counts only payments a staff member verified. Orders awaiting verification, unpaid, failed or refunded are not included.', type: String }, null],
    [{ value: 'This file contains customer names, emails and phone numbers. Store and share it carefully.', type: String, fontWeight: 'bold' as const }, null],
  ];

  const sheets = [
    { data: orderRows, sheet: 'Orders', stickyRowsCount: 1, columns: [{ width: 11 }, { width: 17 }, { width: 22 }, { width: 28 }, { width: 15 }, { width: 11 }, { width: 44 }, { width: 28 }, { width: 11 }, { width: 10 }, { width: 11 }, { width: 20 }, { width: 20 }, { width: 17 }, { width: 19 }, { width: 28 }] },
    { data: itemRows, sheet: 'Items', stickyRowsCount: 1, columns: [{ width: 11 }, { width: 17 }, { width: 22 }, { width: 28 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 19 }, { width: 20 }] },
    { data: summaryRows, sheet: 'Summary', columns: [{ width: 30 }, { width: 24 }] },
  ];
  return writeExcelFile(sheets).toBuffer();
}
