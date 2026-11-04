import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { PasswordResetNotifier } from '../src/auth/password-reset.notifier';
import { PrismaService } from '../src/prisma/prisma.service';
import { setupApp } from '../src/setup-app';

const ORIGIN = 'http://localhost:3000';
const PW = 'a-long-test-password-1';
const OWNER = 'e2e-owner@admin.example';
const STAFF = 'e2e-staff@admin.example';
const CUSTOMER = 'e2e-customer@orders.example';

async function build(notifier?: { send: jest.Mock }) {
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (notifier) builder = builder.overrideProvider(PasswordResetNotifier).useValue(notifier);
  const app = (await builder.compile()).createNestApplication();
  setupApp(app);
  await app.init();
  return app;
}

describe('Admin auth & dashboard (e2e, requires seeded db)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const notifier = { send: jest.fn().mockResolvedValue(undefined) };

  const http = () => request(app.getHttpServer());
  const csrf = <T extends request.Test>(r: T) => r.set('Origin', ORIGIN).set('X-Requested-With', 'shree-admin');
  const login = (email: string, password = PW) => csrf(http().post('/api/v1/admin/auth/login')).send({ email, password });
  const cookieOf = (res: request.Response): string => {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    return (raw ?? []).find((c) => c.startsWith('sf_admin='))?.split(';')[0] ?? '';
  };
  const sessionFor = async (email: string) => cookieOf(await login(email).expect(200));
  const dash = (cookie: string, qs = '') => http().get(`/api/v1/admin/dashboard${qs}`).set('Cookie', cookie);

  beforeAll(async () => {
    app = await build(notifier);
    prisma = app.get(PrismaService);
    // Start clean even if an earlier (or browser-test) run left accounts behind.
    await prisma.adminUser.deleteMany({ where: { email: { endsWith: '@admin.example' } } });
    await prisma.order.deleteMany({ where: { customerEmail: CUSTOMER } });
    const passwordHash = await hashPassword(PW);
    await prisma.adminUser.createMany({
      data: [
        { email: OWNER, name: 'E2E Owner', role: 'OWNER', passwordHash },
        { email: STAFF, name: 'E2E Staff', role: 'STAFF', passwordHash },
      ],
    });
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { customerEmail: CUSTOMER } });
    await prisma.adminUser.deleteMany({ where: { email: { endsWith: '@admin.example' } } });
    await app.close();
  });

  describe('access control', () => {
    it('blocks every admin route without a session', async () => {
      await http().get('/api/v1/admin/dashboard').expect(401);
      await http().get('/api/v1/admin/orders').expect(401);
      await http().get('/api/v1/admin/auth/me').expect(401);
    });

    it('rejects a forged or garbage cookie', async () => {
      await dash('sf_admin=not-a-real-token').expect(401);
      await dash(`sf_admin=${randomBytes(32).toString('base64url')}`).expect(401);
    });

    it('does not expose the cookie to scripts and sets SameSite', async () => {
      const res = await login(OWNER).expect(200);
      const header = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('sf_admin='))!;
      expect(header).toMatch(/HttpOnly/i);
      expect(header).toMatch(/SameSite=Lax/i);
      expect(JSON.stringify(res.body)).not.toMatch(/password|hash/i);
    });

    it('rejects an expired session', async () => {
      const cookie = await sessionFor(OWNER);
      await dash(cookie).expect(200);
      await prisma.adminSession.updateMany({ where: { admin: { email: OWNER } }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await dash(cookie).expect(401);
    });

    it('rejects a session once the admin is deactivated', async () => {
      const cookie = await sessionFor(STAFF);
      await dash(cookie).expect(200);
      await prisma.adminUser.update({ where: { email: STAFF }, data: { isActive: false } });
      await dash(cookie).expect(401);
      await login(STAFF).expect(401);
      await prisma.adminUser.update({ where: { email: STAFF }, data: { isActive: true } });
    });
  });

  describe('login & logout', () => {
    it('gives the same generic error for a wrong password and an unknown email', async () => {
      const wrong = await login(OWNER, 'wrong-password-123').expect(401);
      const unknown = await login('nobody@admin.example').expect(401);
      expect(wrong.body.message).toBe(unknown.body.message);
    });

    it('blocks cross-site and header-less state changes (CSRF)', async () => {
      await http().post('/api/v1/admin/auth/login').set('Origin', ORIGIN).send({ email: OWNER, password: PW }).expect(403); // no custom header
      await http().post('/api/v1/admin/auth/login').set('Origin', 'https://evil.example').set('X-Requested-With', 'shree-admin').send({ email: OWNER, password: PW }).expect(403);
      const cookie = await sessionFor(OWNER);
      await http().post('/api/v1/admin/auth/logout').set('Cookie', cookie).set('Origin', 'https://evil.example').expect(403);
      await dash(cookie).expect(200); // the forged logout did nothing
    });

    it('logout destroys the session on the server', async () => {
      await prisma.adminSession.deleteMany({ where: { admin: { email: OWNER } } });
      const cookie = await sessionFor(OWNER);
      expect(await prisma.adminSession.count({ where: { admin: { email: OWNER } } })).toBe(1);
      await csrf(http().post('/api/v1/admin/auth/logout')).set('Cookie', cookie).expect(200);
      await dash(cookie).expect(401);
      expect(await prisma.adminSession.count({ where: { admin: { email: OWNER } } })).toBe(0);
    });

    it('stores only a hash of the session token', async () => {
      const cookie = await sessionFor(OWNER);
      const token = cookie.split('=')[1];
      expect(await prisma.adminSession.count({ where: { tokenHash: token } })).toBe(0);
    });

    it('validates the login payload', async () => {
      await login('not-an-email').expect(400);
      await csrf(http().post('/api/v1/admin/auth/login')).send({}).expect(400);
    });
  });

  describe('dashboard & orders', () => {
    let ownerCookie: string;
    let staffCookie: string;
    const day = () => {
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const to = new Date(Date.now() + 3_600_000).toISOString();
      return `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    };
    const mkOrder = (data: Record<string, unknown>) =>
      prisma.order.create({
        data: {
          publicToken: randomBytes(24).toString('base64url'),
          customerName: 'Dash Customer',
          customerEmail: CUSTOMER,
          customerPhone: '+15550102030',
          fulfillmentType: 'PICKUP',
          subtotalCents: 1000,
          taxCents: 83,
          totalCents: 1083,
          items: { create: [{ nameSnapshot: 'Vada Pav', unitPriceCents: 1000, quantity: 1, lineTotalCents: 1000 }] },
          ...data,
        },
      });

    beforeAll(async () => {
      ownerCookie = await sessionFor(OWNER);
      staffCookie = await sessionFor(STAFF);
    });

    it('counts revenue only from verified (PAID) payments, and only for owners', async () => {
      const before = (await dash(ownerCookie, day()).expect(200)).body.range.revenueCents as number;
      await mkOrder({ paymentStatus: 'UNPAID' });
      await mkOrder({ paymentStatus: 'AWAITING_VERIFICATION', paymentReportedAt: new Date() });
      await mkOrder({ paymentStatus: 'FAILED' });
      expect((await dash(ownerCookie, day()).expect(200)).body.range.revenueCents).toBe(before); // nothing verified yet

      await mkOrder({ paymentStatus: 'PAID', paymentVerifiedAt: new Date() });
      expect((await dash(ownerCookie, day()).expect(200)).body.range.revenueCents).toBe(before + 1083);

      const staff = await dash(staffCookie, day()).expect(200);
      expect(staff.body.range.revenueCents).toBeNull(); // enforced on the server, not just hidden in the UI
    });

    it('reports queue counts', async () => {
      await mkOrder({ paymentStatus: 'AWAITING_VERIFICATION' });
      const res = await dash(ownerCookie).expect(200);
      expect(res.body.queue.pendingAcceptance).toBeGreaterThanOrEqual(1);
      expect(res.body.queue.awaitingPaymentVerification).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(res.body.recentActivity)).toBe(true);
    });

    it('rejects bad date ranges', async () => {
      await dash(ownerCookie, '?from=yesterday').expect(400);
      await dash(ownerCookie, `?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z`).expect(400);
      await dash(ownerCookie, `?from=2020-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`).expect(400);
    });

    it('lists orders with customer details for admins, with filters and search', async () => {
      const o = await mkOrder({ customerName: 'Searchable Zed', paymentStatus: 'PAID', fulfillmentStatus: 'PREPARING', paymentVerifiedAt: new Date() });
      const get = (qs: string) => http().get(`/api/v1/admin/orders${qs}`).set('Cookie', staffCookie);

      const byName = (await get('?q=searchable%20zed').expect(200)).body;
      expect(byName.orders.map((x: { id: string }) => x.id)).toEqual([o.id]);
      expect(byName.orders[0]).toMatchObject({ customerEmail: CUSTOMER, customerPhone: '+15550102030', items: [{ name: 'Vada Pav', quantity: 1 }] });

      const byNumber = (await get(`?q=SF-${String(o.orderNumber).padStart(4, '0')}`).expect(200)).body;
      expect(byNumber.orders[0].id).toBe(o.id);

      const byStatus = (await get('?status=PREPARING&payment=PAID&q=zed').expect(200)).body;
      expect(byStatus.total).toBe(1);
      expect((await get('?status=READY&q=zed').expect(200)).body.total).toBe(0);
      await get('?status=NONSENSE').expect(400);
      await get('?page=0').expect(400);
      await get('?q=%00').expect(200); // NUL bytes are stripped, not a 500
    });
  });

  describe('password reset', () => {
    const capturedToken = () => notifier.send.mock.calls.at(-1)?.[1] as string;
    const forgot = (email: string) => csrf(http().post('/api/v1/admin/auth/forgot-password')).send({ email });
    const reset = (token: string, password: string) => csrf(http().post('/api/v1/admin/auth/reset-password')).send({ token, password });

    it('responds identically for known and unknown emails and sends nothing for unknown ones', async () => {
      notifier.send.mockClear();
      const unknown = await forgot('ghost@admin.example').expect(200);
      expect(notifier.send).not.toHaveBeenCalled();
      const known = await forgot(STAFF).expect(200);
      expect(known.body).toEqual(unknown.body);
      expect(notifier.send).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(known.body)).not.toContain(capturedToken()); // token is never returned over the API
    });

    it('resets the password once, signs out other sessions, and stores only a token hash', async () => {
      const oldSession = await sessionFor(STAFF);
      await forgot(STAFF).expect(200);
      const token = capturedToken();
      expect(await prisma.passwordResetToken.count({ where: { tokenHash: token } })).toBe(0);

      await reset(token, 'a-brand-new-password-9').expect(200);
      await dash(oldSession).expect(401); // existing sessions revoked
      await login(STAFF).expect(401); // old password dead
      await login(STAFF, 'a-brand-new-password-9').expect(200);
      await reset(token, 'another-password-for-reuse').expect(401); // single use
    });

    it('rejects weak passwords, bogus tokens and expired tokens', async () => {
      await forgot(STAFF).expect(200);
      const token = capturedToken();
      await reset(token, 'short').expect(400);
      await reset('x'.repeat(43), 'a-perfectly-fine-password').expect(401);
      await prisma.passwordResetToken.updateMany({ where: { admin: { email: STAFF }, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await reset(token, 'a-perfectly-fine-password').expect(401);
    });
  });
});

describe('Login rate limiting (e2e)', () => {
  let app: INestApplication;
  const original = process.env.NODE_ENV;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development'; // the test environment disables throttling everywhere else
    app = await build();
  });
  afterAll(async () => {
    process.env.NODE_ENV = original;
    await app.close();
  });

  it('returns 429 after repeated failed logins from one client', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/api/v1/admin/auth/login')
        .set('Origin', ORIGIN)
        .set('X-Requested-With', 'shree-admin')
        .send({ email: 'brute@admin.example', password: 'guess-guess-guess' });
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await attempt()).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});
