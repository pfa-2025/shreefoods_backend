import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { PrismaService } from '../src/prisma/prisma.service';
import { setupApp } from '../src/setup-app';

const ORIGIN = 'http://localhost:3000';
const PW = 'a-long-test-password-1';
const STAFF = 'e2e-live-staff@admin.example';
const CUSTOMER = 'e2e-live@orders.example';

describe('Live orders: staff actions, snapshot and stream (e2e, requires seeded db)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let itemId: string;

  const api = () => request(app.getHttpServer());
  const csrf = <T extends request.Test>(r: T) => r.set('Origin', ORIGIN).set('X-Requested-With', 'shree-admin');
  const act = (id: string, action: string, body: object = {}) => csrf(api().post(`/api/v1/admin/orders/${id}/${action}`)).set('Cookie', cookie).send(body);
  const setStatus = (id: string, status: string) => act(id, 'status', { status });

  /** A real customer order via the public API. */
  async function placeOrder(opts: { report?: boolean } = {}) {
    const res = await api()
      .post('/api/v1/orders')
      .send({
        customerName: 'Live Customer',
        customerEmail: CUSTOMER,
        customerPhone: '(555)010-2030',
        fulfillmentType: 'PICKUP',
        idempotencyKey: randomBytes(16).toString('hex'),
        items: [{ menuItemId: itemId, quantity: 1 }],
      })
      .expect(201);
    if (opts.report) await api().post(`/api/v1/orders/${res.body.token}/report-payment`).send({}).expect(200);
    const order = await prisma.order.findUniqueOrThrow({ where: { publicToken: res.body.token } });
    return { id: order.id, token: res.body.token as string, orderNumber: order.orderNumber };
  }
  const paidOrder = async () => {
    const o = await placeOrder({ report: true });
    await act(o.id, 'verify-payment').expect(200);
    return o;
  };
  const eventTypes = async (orderId: string) => (await prisma.orderEvent.findMany({ where: { orderId }, orderBy: { seq: 'asc' } })).map((e) => e.type);

  beforeAll(async () => {
    app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
    setupApp(app);
    await app.init();
    await app.listen(0); // real socket, needed for the SSE tests
    prisma = app.get(PrismaService);
    itemId = (await prisma.menuItem.findUniqueOrThrow({ where: { slug: 'vada-pav' } })).id;
    await prisma.adminUser.deleteMany({ where: { email: STAFF } });
    await prisma.order.deleteMany({ where: { customerEmail: CUSTOMER } });
    await prisma.adminUser.create({ data: { email: STAFF, name: 'Live Staff', role: 'STAFF', passwordHash: await hashPassword(PW) } });
    const login = await csrf(api().post('/api/v1/admin/auth/login')).send({ email: STAFF, password: PW }).expect(200);
    cookie = ((login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('sf_admin=')) ?? '').split(';')[0];
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerEmail: CUSTOMER } });
    await prisma.adminUser.deleteMany({ where: { email: STAFF } });
    await app.close();
  });

  describe('authorization', () => {
    it('rejects every action without a session, and without the CSRF header', async () => {
      const o = await placeOrder({ report: true });
      for (const a of ['verify-payment', 'reject-payment', 'status', 'cancel', 'acknowledge']) {
        await csrf(api().post(`/api/v1/admin/orders/${o.id}/${a}`)).send({ status: 'ACCEPTED', reason: 'testing' }).expect(401);
        await api().post(`/api/v1/admin/orders/${o.id}/${a}`).set('Cookie', cookie).send({ status: 'ACCEPTED', reason: 'testing' }).expect(403);
      }
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).paymentStatus).toBe('AWAITING_VERIFICATION');
    });

    it('answers 404 for unknown orders and 400 for invalid input', async () => {
      await act('nope', 'verify-payment').expect(404);
      const o = await paidOrder();
      await setStatus(o.id, 'NONSENSE').expect(400);
      await setStatus(o.id, 'CANCELLED').expect(400); // cancelling must go through the explicit cancel action
      await setStatus(o.id, 'PENDING_ACCEPTANCE').expect(400);
    });
  });

  describe('workflow', () => {
    it('runs the full lifecycle, recording who did what', async () => {
      const o = await placeOrder({ report: true });
      const staff = await prisma.adminUser.findUniqueOrThrow({ where: { email: STAFF } });

      expect((await act(o.id, 'verify-payment').expect(200)).body.paymentStatus).toBe('PAID');
      expect((await setStatus(o.id, 'ACCEPTED').expect(200)).body.acknowledgedAt).not.toBeNull();
      await setStatus(o.id, 'PREPARING').expect(200);
      await setStatus(o.id, 'READY').expect(200);
      const done = await setStatus(o.id, 'COMPLETED').expect(200);
      expect(done.body).toMatchObject({ fulfillmentStatus: 'COMPLETED', paymentStatus: 'PAID' });

      expect(await eventTypes(o.id)).toEqual(['ORDER_CREATED', 'PAYMENT_REPORTED', 'PAYMENT_VERIFIED', 'STATUS_CHANGED', 'STATUS_CHANGED', 'STATUS_CHANGED', 'STATUS_CHANGED']);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { events: true } });
      expect(row.paymentVerifiedBy).toBe(staff.id);
      expect(row.paymentVerifiedAt).not.toBeNull();
      expect(row.events.filter((e) => e.type !== 'ORDER_CREATED' && e.type !== 'PAYMENT_REPORTED').every((e) => e.actorId === staff.id)).toBe(true);

      const pub = await api().get(`/api/v1/orders/${o.token}`).expect(200); // the customer's page reflects it
      expect(pub.body).toMatchObject({ fulfillmentStatus: 'COMPLETED', paymentStatus: 'PAID' });
    });

    it('will not accept or progress an order until its payment is verified', async () => {
      const unpaid = await placeOrder();
      const awaiting = await placeOrder({ report: true });
      for (const o of [unpaid, awaiting]) {
        await setStatus(o.id, 'ACCEPTED').expect(409);
        await setStatus(o.id, 'READY').expect(409);
        expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).fulfillmentStatus).toBe('PENDING_ACCEPTANCE');
      }
      await act(unpaid.id, 'verify-payment').expect(409); // nothing was reported to verify
    });

    it('a client can never set payment status through the status endpoint', async () => {
      const o = await placeOrder();
      await act(o.id, 'status', { status: 'ACCEPTED', paymentStatus: 'PAID' }).expect(409);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).paymentStatus).toBe('UNPAID');
    });

    it('rejects skipped and backwards transitions, but repeats are harmless', async () => {
      const o = await paidOrder();
      await setStatus(o.id, 'READY').expect(409); // skips accept + preparing
      await setStatus(o.id, 'COMPLETED').expect(409);
      await setStatus(o.id, 'ACCEPTED').expect(200);
      await setStatus(o.id, 'ACCEPTED').expect(200); // idempotent
      await setStatus(o.id, 'PREPARING').expect(200);
      await setStatus(o.id, 'READY').expect(200);
      await setStatus(o.id, 'PREPARING').expect(409); // no going back
      await setStatus(o.id, 'COMPLETED').expect(200);
      await setStatus(o.id, 'READY').expect(409); // terminal
      expect((await eventTypes(o.id)).filter((t) => t === 'STATUS_CHANGED')).toHaveLength(4);
    });

    it('verifying twice records one event', async () => {
      const o = await placeOrder({ report: true });
      await act(o.id, 'verify-payment').expect(200);
      await act(o.id, 'verify-payment').expect(200);
      expect((await eventTypes(o.id)).filter((t) => t === 'PAYMENT_VERIFIED')).toHaveLength(1);
    });

    it('survives staff clicking at the same time: exactly one effect, never a corrupt state', async () => {
      const o = await placeOrder({ report: true });
      const verifies = await Promise.all(Array.from({ length: 6 }, () => act(o.id, 'verify-payment')));
      expect(verifies.every((r) => [200, 409].includes(r.status))).toBe(true);
      expect(verifies.some((r) => r.status === 200)).toBe(true);
      expect((await eventTypes(o.id)).filter((t) => t === 'PAYMENT_VERIFIED')).toHaveLength(1);

      const accepts = await Promise.all(Array.from({ length: 6 }, () => setStatus(o.id, 'ACCEPTED')));
      expect(accepts.every((r) => [200, 409].includes(r.status))).toBe(true);
      expect((await eventTypes(o.id)).filter((t) => t === 'STATUS_CHANGED')).toHaveLength(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).fulfillmentStatus).toBe('ACCEPTED');
    });
  });

  describe('payment rejection', () => {
    it('marks the payment failed, and the customer can report again', async () => {
      const o = await placeOrder({ report: true });
      const r = await act(o.id, 'reject-payment', { reason: 'Amount did not arrive' }).expect(200);
      expect(r.body.paymentStatus).toBe('FAILED');
      await act(o.id, 'verify-payment').expect(409); // a failed payment never becomes PAID directly
      await setStatus(o.id, 'ACCEPTED').expect(409);
      const first = (await api().get('/api/v1/admin/live/snapshot').set('Cookie', cookie)).body.orders.find((x: { id: string }) => x.id === o.id);
      expect(first.acknowledgedAt).not.toBeNull(); // rejecting counts as seen
      const again = await api().post(`/api/v1/orders/${o.token}/report-payment`).send({}).expect(200);
      expect(again.body.paymentStatus).toBe('AWAITING_VERIFICATION');
      const second = (await api().get('/api/v1/admin/live/snapshot').set('Cookie', cookie)).body.orders.find((x: { id: string }) => x.id === o.id);
      expect(second.acknowledgedAt).toBeNull(); // needs attention again
      expect(BigInt(second.alertSeq)).toBeGreaterThan(BigInt(first.alertSeq)); // new alert id, so the hooter sounds again
      await act(o.id, 'verify-payment').expect(200);
    });
  });

  describe('cancellation and refunds', () => {
    it('requires a reason', async () => {
      const o = await placeOrder();
      await act(o.id, 'cancel', {}).expect(400);
      await act(o.id, 'cancel', { reason: 'x' }).expect(400);
    });

    it('cancels an unpaid order without touching payment', async () => {
      const o = await placeOrder();
      const r = await act(o.id, 'cancel', { reason: 'Customer called to cancel' }).expect(200);
      expect(r.body).toMatchObject({ fulfillmentStatus: 'CANCELLED', paymentStatus: 'UNPAID', cancelReason: 'Customer called to cancel' });
      await api().post(`/api/v1/orders/${o.token}/report-payment`).send({}).expect(409); // can't pay for a cancelled order
    });

    it('treats an unverified reported payment as not received', async () => {
      const o = await placeOrder({ report: true });
      expect((await act(o.id, 'cancel', { reason: 'Kitchen closed early' }).expect(200)).body.paymentStatus).toBe('FAILED');
    });

    it('refuses to cancel a paid order unless the refund is confirmed, then records it', async () => {
      const o = await paidOrder();
      await act(o.id, 'cancel', { reason: 'Out of stock' }).expect(409);
      await act(o.id, 'cancel', { reason: 'Out of stock', refundIssued: false }).expect(409);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).fulfillmentStatus).toBe('PENDING_ACCEPTANCE');

      const r = await act(o.id, 'cancel', { reason: 'Out of stock', refundIssued: true }).expect(200);
      expect(r.body).toMatchObject({ fulfillmentStatus: 'CANCELLED', paymentStatus: 'REFUNDED' });
      expect((await eventTypes(o.id)).slice(-2)).toEqual(['ORDER_CANCELLED', 'PAYMENT_REFUNDED']);
      await act(o.id, 'cancel', { reason: 'again', refundIssued: true }).expect(200); // idempotent
      expect((await eventTypes(o.id)).filter((t) => t === 'ORDER_CANCELLED')).toHaveLength(1);
    });

    it('cannot cancel a completed order', async () => {
      const o = await paidOrder();
      for (const s of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) await setStatus(o.id, s).expect(200);
      await act(o.id, 'cancel', { reason: 'too late', refundIssued: true }).expect(409);
    });
  });

  describe('acknowledge', () => {
    it('records the acknowledgement once', async () => {
      const o = await placeOrder({ report: true });
      expect((await act(o.id, 'acknowledge').expect(200)).body.acknowledgedAt).not.toBeNull();
      await act(o.id, 'acknowledge').expect(200);
      expect((await eventTypes(o.id)).filter((t) => t === 'ALERT_ACKNOWLEDGED')).toHaveLength(1);
    });
  });

  describe('snapshot', () => {
    it('requires a session', async () => {
      await api().get('/api/v1/admin/live/snapshot').expect(401);
    });

    it('returns active orders with their alert ids and the latest event seq', async () => {
      const reported = await placeOrder({ report: true });
      const unreported = await placeOrder();
      const res = await api().get('/api/v1/admin/live/snapshot').set('Cookie', cookie).expect(200);
      const byId = new Map<string, { alertSeq: string | null; customerEmail: string }>(res.body.orders.map((o: { id: string; alertSeq: string | null; customerEmail: string }) => [o.id, o]));
      expect(byId.get(reported.id)?.alertSeq).toMatch(/^\d+$/);
      expect(byId.get(unreported.id)?.alertSeq).toBeNull(); // no payment reported, nothing to sound the hooter for
      expect(byId.get(reported.id)?.customerEmail).toBe(CUSTOMER);
      expect(BigInt(res.body.latestSeq)).toBeGreaterThanOrEqual(BigInt(byId.get(reported.id)!.alertSeq!));
      expect(new Set(res.body.orders.map((o: { id: string }) => o.id)).size).toBe(res.body.orders.length); // no duplicates
    });

    it('drops finished orders after 24 hours', async () => {
      const o = await paidOrder();
      for (const s of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) await setStatus(o.id, s).expect(200);
      const ids = async () => ((await api().get('/api/v1/admin/live/snapshot').set('Cookie', cookie)).body.orders as { id: string }[]).map((x) => x.id);
      expect(await ids()).toContain(o.id);
      await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = now() - interval '2 days' WHERE id = ${o.id}`;
      expect(await ids()).not.toContain(o.id);
    });
  });

  describe('live stream (SSE)', () => {
    const port = () => (app.getHttpServer().address() as AddressInfo).port;

    function openStream(cookieHeader?: string) {
      let buffer = '';
      let status = 0;
      let contentType = '';
      const req = http.get({ host: '127.0.0.1', port: port(), path: '/api/v1/admin/live/stream', headers: cookieHeader ? { cookie: cookieHeader } : {} }, (res) => {
        status = res.statusCode ?? 0;
        contentType = String(res.headers['content-type']);
        res.setEncoding('utf8');
        res.on('data', (c: string) => (buffer += c));
      });
      req.on('error', () => undefined);
      const waitFor = async (pred: (b: string) => boolean, ms = 4000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          if (pred(buffer)) return buffer;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`timed out waiting for stream data. Got: ${buffer.slice(-400)}`);
      };
      return { waitFor, close: () => req.destroy(), get status() { return status; }, get contentType() { return contentType; }, get buffer() { return buffer; } };
    }

    it('refuses anonymous clients', async () => {
      const s = openStream();
      await new Promise((r) => setTimeout(r, 300));
      expect(s.status).toBe(401);
      s.close();
    });

    it('streams order events to signed-in staff, only after the change is saved', async () => {
      const s = openStream(cookie);
      await s.waitFor((b) => b.includes('event: ready'));
      expect(s.contentType).toContain('text/event-stream');

      const o = await placeOrder();
      await api().post(`/api/v1/orders/${o.token}/report-payment`).send({ reference: 'LIVE-1' }).expect(200);
      const text = await s.waitFor((b) => b.includes('"PAYMENT_REPORTED"') && b.includes(`"orderNumber":${o.orderNumber}`));

      // by the time the client hears about it, the database already says so
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).paymentStatus).toBe('AWAITING_VERIFICATION');
      const block = text.split('\n\n').find((b) => b.includes('"PAYMENT_REPORTED"') && b.includes(`"orderNumber":${o.orderNumber}`))!;
      const id = /^id: (\d+)$/m.exec(block)![1];
      const payload = JSON.parse(/^data: (.*)$/m.exec(block)![1]);
      expect(payload.seq).toBe(id);
      expect(payload.order.alertSeq).toBe(id); // the hooter's de-duplication key
      expect(payload.order.paymentStatus).toBe('AWAITING_VERIFICATION');

      await act(o.id, 'verify-payment').expect(200);
      await s.waitFor((b) => b.includes('"PAYMENT_VERIFIED"'));
      s.close();
    });

    it('a new connection starts clean and the snapshot recovers anything it missed', async () => {
      const missed = await placeOrder({ report: true }); // happens while no client is connected
      const s = openStream(cookie);
      await s.waitFor((b) => b.includes('event: ready'));
      expect(s.buffer).not.toContain(`"orderNumber":${missed.orderNumber}`); // no replay, so no duplicate alert
      const snap = await api().get('/api/v1/admin/live/snapshot').set('Cookie', cookie).expect(200);
      expect(snap.body.orders.some((x: { id: string }) => x.id === missed.id)).toBe(true); // but it is recoverable
      s.close();
    });
  });
});
