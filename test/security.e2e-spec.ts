import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { boot } from './cms-helpers';

interface Route {
  method: string;
  path: string;
}

/** Every route the running app has actually registered (not a hand-kept list). */
function listRoutes(app: INestApplication): Route[] {
  const instance = app.getHttpAdapter().getInstance() as { router?: { stack: unknown[] }; _router?: { stack: unknown[] } };
  const stack = (instance.router ?? instance._router)?.stack as { route?: { path: string; methods: Record<string, boolean> } }[];
  const routes: Route[] = [];
  for (const layer of stack ?? []) {
    if (layer.route) for (const m of Object.keys(layer.route.methods)) routes.push({ method: m.toUpperCase(), path: layer.route.path });
  }
  return routes;
}
const key = (r: Route) => `${r.method} ${r.path}`;
const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, 'x');

/** Admin routes that are meant to be reachable without a session. */
const PUBLIC_ADMIN = new Set(['POST /api/v1/admin/auth/login', 'POST /api/v1/admin/auth/logout', 'POST /api/v1/admin/auth/forgot-password', 'POST /api/v1/admin/auth/reset-password']);

/** Every non-admin route, reviewed one by one. A new route fails the test until someone decides it is meant to be public. */
const PUBLIC = new Set([
  'GET /api/v1/health', 'GET /api/v1/health/ready', 'GET /api/v1/site', 'GET /api/v1/announcements', 'GET /api/v1/menu',
  'GET /api/v1/pages/:key', 'GET /api/v1/uploads/:key', 'POST /api/v1/cart/quote', 'GET /api/v1/reviews', 'POST /api/v1/orders/:token/review',
  'POST /api/v1/orders', 'GET /api/v1/orders/:token', 'POST /api/v1/orders/:token/report-payment',
]);

/** What a STAFF (non-owner) account may do. Anything else under /admin must answer 403. */
const STAFF_ALLOWED = new Set([
  'GET /api/v1/admin/dashboard', 'GET /api/v1/admin/orders', 'GET /api/v1/admin/orders/:id/emails', 'POST /api/v1/admin/emails/:id/retry',
  'POST /api/v1/admin/orders/:id/verify-payment', 'POST /api/v1/admin/orders/:id/reject-payment', 'POST /api/v1/admin/orders/:id/status',
  'POST /api/v1/admin/orders/:id/cancel', 'POST /api/v1/admin/orders/:id/acknowledge',
  'GET /api/v1/admin/live/snapshot', 'GET /api/v1/admin/live/stream', 'GET /api/v1/admin/menu', 'PATCH /api/v1/admin/menu/items/:id/availability', 'GET /api/v1/admin/auth/me',
]);

describe('Security review (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let routes: Route[];

  beforeAll(async () => {
    ctx = await boot('e2e-sec');
    routes = listRoutes(ctx.app);
  });
  afterAll(async () => {
    await ctx.prisma.order.deleteMany({ where: { customerEmail: 'e2e-sec@orders.example' } });
    await ctx.close();
  });

  describe('authorization coverage (driven by the real route table)', () => {
    it('finds the routes (guards the test itself)', () => {
      expect(routes.length).toBeGreaterThan(40);
      expect(routes.some((r) => r.path.startsWith('/api/v1/admin'))).toBe(true);
    });

    it('every admin route answers 401 without a session', async () => {
      const admin = routes.filter((r) => r.path.startsWith('/api/v1/admin') && !PUBLIC_ADMIN.has(key(r)));
      expect(admin.length).toBeGreaterThan(25);
      for (const r of admin) {
        const res = await ctx
          .api()
          [r.method.toLowerCase() as 'get']( concrete(r.path))
          .set('Origin', 'http://localhost:3000')
          .set('X-Requested-With', 'shree-admin')
          .send({});
        expect({ route: key(r), status: res.status }).toEqual({ route: key(r), status: 401 });
      }
    });

    it('every non-admin route is on the reviewed public list (and nothing on the list has vanished)', () => {
      const nonAdmin = routes.filter((r) => !r.path.startsWith('/api/v1/admin')).map(key);
      expect(nonAdmin.filter((r) => !PUBLIC.has(r))).toEqual([]);
      expect([...PUBLIC].filter((r) => !nonAdmin.includes(r))).toEqual([]);
    });

    it('staff are refused (403) on every owner-only admin route', async () => {
      const ownerOnly = routes.filter((r) => r.path.startsWith('/api/v1/admin') && !PUBLIC_ADMIN.has(key(r)) && !STAFF_ALLOWED.has(key(r)));
      expect(ownerOnly.length).toBeGreaterThan(12);
      for (const r of ownerOnly) {
        const res = await ctx
          .api()
          [r.method.toLowerCase() as 'get'](concrete(r.path))
          .set('Cookie', ctx.staffCookie)
          .set('Origin', 'http://localhost:3000')
          .set('X-Requested-With', 'shree-admin')
          .send({});
        expect({ route: key(r), status: res.status }).toEqual({ route: key(r), status: 403 });
      }
    });

    it('state-changing admin routes also demand the CSRF header, even with a valid session', async () => {
      const writes = routes.filter((r) => r.path.startsWith('/api/v1/admin') && r.method !== 'GET' && !PUBLIC_ADMIN.has(key(r)));
      for (const r of writes) {
        const res = await ctx.api()[r.method.toLowerCase() as 'post'](concrete(r.path)).set('Cookie', ctx.ownerCookie).send({});
        expect({ route: key(r), status: res.status }).toEqual({ route: key(r), status: 403 });
      }
    });
  });

  describe('public data exposure', () => {
    it('/site exposes only public restaurant info (no tax, payment or internal settings)', async () => {
      const body = (await ctx.api().get('/api/v1/site').expect(200)).body;
      expect(Object.keys(body).sort()).toEqual(['address', 'cartEnabled', 'email', 'fulfillment', 'openingHours', 'ordersOpen', 'phone', 'restaurantName', 'socialLinks']);
      expect(JSON.stringify(body)).not.toMatch(/taxRate|paymentQr|paymentHandle|deliveryEnabled/);
    });

    it('/menu hides archived items and internal fields', async () => {
      const text = JSON.stringify((await ctx.api().get('/api/v1/menu').expect(200)).body);
      expect(text).not.toMatch(/isArchived|sortOrder|createdAt|updatedAt/);
    });

    it('responses carry hardening headers and never advertise the framework', async () => {
      const res = await ctx.api().get('/api/v1/menu').expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-frame-options']).toBeDefined();
    });
  });

  describe('CORS', () => {
    const preflight = (origin: string) =>
      ctx.api().options('/api/v1/cart/quote').set('Origin', origin).set('Access-Control-Request-Method', 'POST').set('Access-Control-Request-Headers', 'content-type');

    it('allows the configured website, with credentials', async () => {
      const res = await preflight('http://localhost:3000');
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });
    it('gives other origins no permission', async () => {
      for (const origin of ['https://evil.example', 'http://localhost:3001', 'null', 'http://localhost:3000.evil.example']) {
        const res = await preflight(origin);
        expect({ origin, allow: res.headers['access-control-allow-origin'] }).toEqual({ origin, allow: undefined });
      }
    });
  });

  describe('request handling', () => {
    it('rejects oversized bodies and malformed JSON with clean client errors', async () => {
      const big = await ctx.api().post('/api/v1/cart/quote').send({ items: [], pad: 'x'.repeat(200_000) });
      expect(big.status).toBe(413);
      expect(big.body.message).toBe('Request body too large');
      const bad = await ctx.api().post('/api/v1/cart/quote').set('Content-Type', 'application/json').send('{"items": [');
      expect(bad.status).toBe(400);
      expect(bad.body.message).toBe('Malformed JSON');
      expect(JSON.stringify(bad.body)).not.toMatch(/Unexpected|position|at \w+/);
    });

    it('tags every response with a request id, echoes a sane one, and replaces junk', async () => {
      const generated = await ctx.api().get('/api/v1/health');
      expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      const echoed = await ctx.api().get('/api/v1/nope').set('X-Request-Id', 'trace-abcdef12');
      expect(echoed.headers['x-request-id']).toBe('trace-abcdef12');
      expect(echoed.body.requestId).toBe('trace-abcdef12'); // customers can quote it from an error
      const junk = await ctx.api().get('/api/v1/health').set('X-Request-Id', '<script>alert(1)</script>');
      expect(junk.headers['x-request-id']).not.toContain('<');
    });

    it('treats SQL-looking input as plain text', async () => {
      const evil = "x' OR '1'='1'; DROP TABLE \"Order\"; --";
      await ctx.owner.get(`/admin/orders?q=${encodeURIComponent(evil)}`).expect(200);
      await ctx.api().get(`/api/v1/orders/${encodeURIComponent(evil)}`).expect(404);
      await ctx.api().get(`/api/v1/pages/${encodeURIComponent(evil)}`).expect(404);
      expect(await ctx.prisma.order.count()).toBeGreaterThanOrEqual(0); // table still exists
    });
  });

  describe('abuse limits', () => {
    const original = process.env.NODE_ENV;
    afterAll(() => {
      process.env.NODE_ENV = original;
    });

    it('limits how fast one client can place orders and report payments', async () => {
      process.env.NODE_ENV = 'development'; // the test environment disables throttling everywhere else
      const item = await ctx.prisma.menuItem.findFirstOrThrow({ where: { isAvailable: true, isArchived: false } });
      const place = () =>
        ctx.api().post('/api/v1/orders').send({
          customerName: 'Rate Test', customerEmail: 'e2e-sec@orders.example', customerPhone: '(555)010-2030', fulfillmentType: 'PICKUP',
          idempotencyKey: randomBytes(16).toString('hex'), items: [{ menuItemId: item.id, quantity: 1 }],
        });
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await place()).status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(10);
      expect(statuses.slice(10)).toEqual([429, 429]);
      expect((await ctx.api().post('/api/v1/orders/x/report-payment').send({})).status).toBe(404); // different limiter bucket still works
    });
  });

  describe('source review', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? walk(path.join(dir, f)) : [path.join(dir, f)]));
    const src = walk(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

    it('never builds SQL from strings (only parameterised Prisma queries)', () => {
      for (const f of src) {
        const text = readFileSync(f, 'utf8');
        expect({ f: path.basename(f), unsafe: /\$(query|execute)RawUnsafe|Prisma\.raw\(/.test(text) }).toEqual({ f: path.basename(f), unsafe: false });
      }
    });

    it('does not log secrets or whole request bodies', () => {
      for (const f of src) {
        const text = readFileSync(f, 'utf8');
        expect({ f: path.basename(f), leaks: /(?:logger|console|log)\.(?:log|warn|error|debug|verbose)\([^)]*(?:password|passwordHash|SESSION_SECRET|API_KEY|apiSecret|req\.body)/i.test(text) }).toEqual({ f: path.basename(f), leaks: false });
      }
    });
  });
});
