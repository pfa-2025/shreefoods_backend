import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { setupApp } from '../src/setup-app';

const TEST_EMAIL = 'e2e-test@orders.example';

describe('Orders (e2e, requires seeded db)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let vada: { id: string; priceCents: number };
  let misal: { id: string; priceCents: number };

  const key = () => randomBytes(16).toString('hex');
  const body = (over: Record<string, unknown> = {}) => ({
    customerName: 'Test Customer',
    customerEmail: TEST_EMAIL,
    customerPhone: '(201) 555-0123',
    fulfillmentType: 'PICKUP',
    idempotencyKey: key(),
    items: [{ menuItemId: vada.id, quantity: 2 }],
    ...over,
  });
  const post = (b: unknown) => request(app.getHttpServer()).post('/api/v1/orders').send(b as object);
  const get = (token: string) => request(app.getHttpServer()).get(`/api/v1/orders/${token}`);
  const report = (token: string, b: object = {}) =>
    request(app.getHttpServer()).post(`/api/v1/orders/${token}/report-payment`).send(b);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    vada = await prisma.menuItem.findUniqueOrThrow({ where: { slug: 'vada-pav' } });
    // Any other dish that is orderable right now (the owner may have switched individual dishes off).
    misal = await prisma.menuItem.findFirstOrThrow({ where: { isAvailable: true, isArchived: false, category: { isArchived: false }, id: { not: vada.id } } });
    const vadaRow = await prisma.menuItem.findUniqueOrThrow({ where: { id: vada.id } });
    if (!vadaRow.isAvailable || vadaRow.isArchived) throw new Error('These tests need "Vada Pav" to be available. It is switched off in your database: mark it available in Admin > Menu, then re-run.');
  });

  afterAll(async () => {
    await prisma.menuItem.update({ where: { id: vada.id }, data: { isAvailable: true } });
    await prisma.siteSettings.update({ where: { id: 'singleton' }, data: { ordersOpen: true, deliveryEnabled: false } });
    await prisma.order.deleteMany({ where: { customerEmail: TEST_EMAIL } });
    await app.close();
  });

  it('creates an order with server-calculated totals and item snapshots', async () => {
    const res = await post(body({ items: [{ menuItemId: vada.id, quantity: 2 }, { menuItemId: misal.id, quantity: 1 }] })).expect(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { publicToken: res.body.token }, include: { items: true, events: true } });
    const subtotal = vada.priceCents * 2 + misal.priceCents;
    expect(order.subtotalCents).toBe(subtotal);
    expect(order.totalCents).toBe(order.subtotalCents + order.taxCents + order.feeCents);
    expect(order.paymentStatus).toBe('UNPAID');
    expect(order.fulfillmentStatus).toBe('PENDING_ACCEPTANCE');
    expect(order.customerPhone).toBe('+12015550123');
    const second = await prisma.menuItem.findUniqueOrThrow({ where: { id: misal.id } });
    expect(order.items.map((i) => i.nameSnapshot).sort()).toEqual([second.name, 'Vada Pav'].sort());
    expect(order.events.map((e) => e.type)).toEqual(['ORDER_CREATED']);
  });

  it('accepts common phone formats, including 555 exchanges with a leading 0', async () => {
    for (const phone of ['(555)010-2030', '(555) 010-2030', '555-010-2030', '+1 555 010 2030', '15550102030']) {
      const res = await post(body({ customerPhone: phone })).expect(201);
      const o = await prisma.order.findUniqueOrThrow({ where: { publicToken: res.body.token } });
      expect(o.customerPhone).toBe('+15550102030');
    }
  });

  it('ignores client-supplied prices and totals', async () => {
    const res = await post(body({ totalCents: 1, subtotalCents: 1, items: [{ menuItemId: vada.id, quantity: 1, priceCents: 1 }] })).expect(201);
    const order = await prisma.order.findUniqueOrThrow({ where: { publicToken: res.body.token } });
    expect(order.subtotalCents).toBe(vada.priceCents);
  });

  it('item snapshots are unaffected by later price changes', async () => {
    const res = await post(body()).expect(201);
    await prisma.menuItem.update({ where: { id: vada.id }, data: { priceCents: vada.priceCents + 500 } });
    const view = await get(res.body.token).expect(200);
    await prisma.menuItem.update({ where: { id: vada.id }, data: { priceCents: vada.priceCents } });
    expect(view.body.items[0].unitPriceCents).toBe(vada.priceCents);
  });

  it('is idempotent: the same key returns the same order', async () => {
    const b = body();
    const a = await post(b).expect(201);
    const again = await post(b).expect(201);
    expect(again.body.token).toBe(a.body.token);
    expect(await prisma.order.count({ where: { idempotencyKey: b.idempotencyKey } })).toBe(1);
  });

  it('creates exactly one order for simultaneous submissions', async () => {
    const b = body();
    const results = await Promise.all(Array.from({ length: 6 }, () => post(b)));
    expect(new Set(results.map((r) => r.body.token)).size).toBe(1);
    expect(await prisma.order.count({ where: { idempotencyKey: b.idempotencyKey } })).toBe(1);
  });

  it('validates customer fields', async () => {
    await post(body({ customerName: '' })).expect(400);
    await post(body({ customerEmail: 'not-an-email' })).expect(400);
    await post(body({ customerPhone: '123' })).expect(400);
    await post(body({ customerPhone: '(155) 010-2030' })).expect(400); // area code can't start with 1
    await post(body({ customerPhone: undefined })).expect(400); // pickup requires a phone
    await post(body({ items: [] })).expect(400);
    await post(body({ idempotencyKey: 'short' })).expect(400);
  });

  it('rejects unavailable items with a 409 and creates nothing', async () => {
    await prisma.menuItem.update({ where: { id: vada.id }, data: { isAvailable: false } });
    const b = body();
    const res = await post(b).expect(409);
    expect(res.body.details[0].code).toBe('UNAVAILABLE');
    expect(await prisma.order.count({ where: { idempotencyKey: b.idempotencyKey } })).toBe(0);
    await prisma.menuItem.update({ where: { id: vada.id }, data: { isAvailable: true } });
  });

  it('rejects disabled order types (delivery/dine-in)', async () => {
    await post(body({ fulfillmentType: 'DELIVERY', deliveryAddress: '1 Main St, Edison NJ' })).expect(422);
    await post(body({ fulfillmentType: 'DINE_IN', customerPhone: undefined })).expect(422);
  });

  it('rejects orders while ordering is closed', async () => {
    await prisma.siteSettings.update({ where: { id: 'singleton' }, data: { ordersOpen: false } });
    await post(body()).expect(409);
    await prisma.siteSettings.update({ where: { id: 'singleton' }, data: { ordersOpen: true } });
  });

  it('rejects orders in menu-only mode (cart hidden)', async () => {
    await prisma.siteSettings.update({ where: { id: 'singleton' }, data: { cartEnabled: false } });
    try {
      await post(body()).expect(409);
    } finally {
      await prisma.siteSettings.update({ where: { id: 'singleton' }, data: { cartEnabled: true } });
    }
  });

  it('public order view hides customer information and exposes payment instructions', async () => {
    const res = await post(body()).expect(201);
    const view = await get(res.body.token).expect(200);
    const json = JSON.stringify(view.body);
    expect(json).not.toContain(TEST_EMAIL);
    expect(json).not.toContain('Test Customer');
    expect(json).not.toContain('5550123');
    expect(view.body.payment.qrUrl).toBe('/images/payment-qr.png');
    expect(view.body.paymentStatus).toBe('UNPAID');
  });

  it('does not reveal orders by sequential number or unknown tokens', async () => {
    await get('1').expect(404);
    await get('definitely-not-a-token').expect(404);
    await report('definitely-not-a-token').expect(404);
  });

  it('reporting payment asks for verification but never marks the order paid', async () => {
    const res = await post(body()).expect(201);
    const r = await report(res.body.token, { reference: 'PP-TXN-123', paymentStatus: 'PAID', status: 'PAID' }).expect(200);
    expect(r.body.paymentStatus).toBe('AWAITING_VERIFICATION');
    const order = await prisma.order.findUniqueOrThrow({ where: { publicToken: res.body.token }, include: { events: true } });
    expect(order.paymentStatus).toBe('AWAITING_VERIFICATION');
    expect(order.paymentVerifiedAt).toBeNull();
    expect(order.paymentReference).toBe('PP-TXN-123');
    expect(order.events.map((e) => e.type)).toEqual(['ORDER_CREATED', 'PAYMENT_REPORTED']);
  });

  it('reporting payment twice is harmless (one event)', async () => {
    const res = await post(body()).expect(201);
    await Promise.all([report(res.body.token), report(res.body.token), report(res.body.token)]);
    await report(res.body.token).expect(200);
    const events = await prisma.orderEvent.count({ where: { order: { publicToken: res.body.token }, type: 'PAYMENT_REPORTED' } });
    expect(events).toBe(1);
  });

  it('cannot report payment on a cancelled order, and a paid order stays paid', async () => {
    const cancelled = await post(body()).expect(201);
    await prisma.order.update({ where: { publicToken: cancelled.body.token }, data: { fulfillmentStatus: 'CANCELLED' } });
    await report(cancelled.body.token).expect(409);

    const paid = await post(body()).expect(201);
    await prisma.order.update({ where: { publicToken: paid.body.token }, data: { paymentStatus: 'PAID' } });
    const r = await report(paid.body.token).expect(200);
    expect(r.body.paymentStatus).toBe('PAID');
    expect(r.body.payment).toBeNull();
  });
});
