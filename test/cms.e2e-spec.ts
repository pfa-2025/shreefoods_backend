import { Prisma } from '@prisma/client';
import { PNG, boot } from './cms-helpers';

describe('CMS: menu, announcements, pages/SEO, settings (e2e, requires seeded db)', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let originalSettings: Awaited<ReturnType<typeof ctx.prisma.siteSettings.findUniqueOrThrow>>;
  const media: string[] = [];

  const publicMenu = async () => (await ctx.api().get('/api/v1/menu')).body.categories as { id: string; name: string; items: { id: string; name: string; priceCents: number; isAvailable: boolean }[] }[];
  const quote = (id: string) => ctx.api().post('/api/v1/cart/quote').send({ items: [{ menuItemId: id, quantity: 1 }] });

  beforeAll(async () => {
    ctx = await boot('e2e-cms');
    originalSettings = await ctx.prisma.siteSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
  });
  afterAll(async () => {
    await ctx.prisma.menuItem.deleteMany({ where: { name: { startsWith: 'E2E ' } } });
    await ctx.prisma.menuCategory.deleteMany({ where: { name: { startsWith: 'E2E ' } } });
    await ctx.prisma.announcement.deleteMany({ where: { title: { startsWith: 'E2E ' } } });
    await ctx.prisma.page.deleteMany({ where: { key: { in: ['menu', 'contact'] } } });
    // Put back the ENTIRE settings row as it was (not just the fields this suite remembers to touch).
    const { id: _id, updatedAt: _updatedAt, ...original } = originalSettings;
    void _id; void _updatedAt;
    await ctx.prisma.siteSettings.update({ where: { id: 'singleton' }, data: original as Prisma.SiteSettingsUncheckedUpdateInput });
    await ctx.prisma.mediaAsset.deleteMany({ where: { id: { in: media } } });
    await ctx.close();
  });

  describe('authorization', () => {
    it('blocks anonymous writes everywhere', async () => {
      for (const [m, p] of [['post', '/admin/menu/categories'], ['post', '/admin/menu/items'], ['post', '/admin/announcements'], ['put', '/admin/pages/home'], ['put', '/admin/settings']] as const) {
        await ctx.api()[m](`/api/v1${p}`).set('Origin', 'http://localhost:3000').set('X-Requested-With', 'shree-admin').send({}).expect(401);
      }
    });

    it('lets staff only list the menu and flip availability; everything else is owner-only', async () => {
      await ctx.staff.get('/admin/menu').expect(200);
      await ctx.staff.post('/admin/menu/categories').send({ name: 'E2E Nope' }).expect(403);
      await ctx.staff.post('/admin/menu/items').send({}).expect(403);
      await ctx.staff.patch('/admin/menu/items/x').send({ priceCents: 1 }).expect(403);
      await ctx.staff.get('/admin/announcements').expect(403);
      await ctx.staff.post('/admin/announcements').send({ title: 'E2E x' }).expect(403);
      await ctx.staff.put('/admin/pages/home').send({}).expect(403);
      await ctx.staff.get('/admin/settings').expect(403);
      await ctx.staff.put('/admin/settings').send({}).expect(403);
    });

    it('enforces the CSRF header and origin on CMS writes, even with a valid session', async () => {
      const post = () => ctx.api().post('/api/v1/admin/menu/categories').set('Cookie', ctx.ownerCookie).send({ name: 'E2E csrf' });
      await post().expect(403); // no custom header
      await post().set('X-Requested-With', 'shree-admin').set('Origin', 'https://evil.example').expect(403); // wrong origin
      expect(await ctx.prisma.menuCategory.count({ where: { name: 'E2E csrf' } })).toBe(0);
    });
  });

  describe('menu manager', () => {
    let catId: string;
    let itemId: string;

    it('creates a new section (e.g. Catering) with no code change, and it shows publicly once it has items', async () => {
      const cat = (await ctx.owner.post('/admin/menu/categories').send({ name: 'E2E Catering' }).expect(201)).body;
      catId = cat.id;
      expect(cat.slug).toBe('e2e-catering');
      const dup = (await ctx.owner.post('/admin/menu/categories').send({ name: 'E2E Catering' }).expect(201)).body;
      expect(dup.slug).toBe('e2e-catering-2'); // slugs stay unique
      await ctx.owner.post('/admin/menu/categories').send({ name: '' }).expect(400);
      expect((await publicMenu()).map((c) => c.name)).toContain('E2E Catering');
    });

    it('creates items with validated prices', async () => {
      const ok = await ctx.owner.post('/admin/menu/items').send({ categoryId: catId, name: 'E2E Party Tray', priceCents: 4500, description: 'Serves 10' }).expect(201);
      itemId = ok.body.id;
      expect(ok.body).toMatchObject({ slug: 'e2e-party-tray', priceCents: 4500, isAvailable: true, isFeatured: false, dietaryLabels: [] });
      for (const bad of [0, -5, 12.5, 1_000_001, '12', null]) {
        await ctx.owner.post('/admin/menu/items').send({ categoryId: catId, name: 'E2E Bad', priceCents: bad }).expect(400);
      }
      await ctx.owner.post('/admin/menu/items').send({ categoryId: 'nope', name: 'E2E Bad', priceCents: 100 }).expect(400);
      await ctx.owner.post('/admin/menu/items').send({ categoryId: catId, name: 'E2E Bad', priceCents: 100, imageId: 'missing' }).expect(400);
      expect((await publicMenu()).find((c) => c.id === catId)?.items.map((i) => i.name)).toEqual(['E2E Party Tray']);
    });

    it('a price change is used by checkout immediately (server is the authority)', async () => {
      await ctx.owner.patch(`/admin/menu/items/${itemId}`).send({ priceCents: 5000 }).expect(200);
      expect((await quote(itemId)).body.subtotalCents).toBe(5000);
    });

    it('PATCH only changes the fields sent', async () => {
      await ctx.owner.patch(`/admin/menu/items/${itemId}`).send({ isFeatured: true, dietaryLabels: ['vegetarian'] }).expect(200);
      const r = await ctx.owner.patch(`/admin/menu/items/${itemId}`).send({ priceCents: 5100 }).expect(200);
      expect(r.body).toMatchObject({ priceCents: 5100, description: 'Serves 10', isFeatured: true, dietaryLabels: ['vegetarian'], isAvailable: true });
    });

    it('staff can mark an item unavailable, which blocks ordering at once', async () => {
      await ctx.staff.patch(`/admin/menu/items/${itemId}/availability`).send({ isAvailable: false }).expect(200);
      const q = (await quote(itemId)).body;
      expect(q.canCheckout).toBe(false);
      expect(q.issues[0].code).toBe('UNAVAILABLE');
      expect((await publicMenu()).find((c) => c.id === catId)?.items[0].isAvailable).toBe(false);
      await ctx.staff.patch(`/admin/menu/items/${itemId}/availability`).send({ isAvailable: 'yes' }).expect(400);
      await ctx.staff.patch(`/admin/menu/items/${itemId}/availability`).send({ isAvailable: true }).expect(200);
    });

    it('duplicates an item as a hidden-from-ordering copy', async () => {
      const copy = (await ctx.owner.post(`/admin/menu/items/${itemId}/duplicate`).expect(201)).body;
      expect(copy).toMatchObject({ name: 'E2E Party Tray (copy)', priceCents: 5100, isAvailable: false, isFeatured: false, categoryId: catId });
      expect(copy.slug).not.toBe('e2e-party-tray');
      await ctx.owner.post('/admin/menu/items/nope/duplicate').expect(404);
    });

    it('reorders items and persists the order publicly', async () => {
      const items = (await ctx.owner.get('/admin/menu')).body.categories.find((c: { id: string }) => c.id === catId).items as { id: string }[];
      expect(items).toHaveLength(2);
      await ctx.owner.put('/admin/menu/items/order').send({ categoryId: catId, ids: [items[1].id, items[0].id] }).expect(200);
      expect((await publicMenu()).find((c) => c.id === catId)?.items.map((i) => i.id)).toEqual([items[1].id, items[0].id]);
      await ctx.owner.put('/admin/menu/items/order').send({ categoryId: catId, ids: [items[0].id, items[0].id] }).expect(400); // duplicates
      await ctx.owner.put('/admin/menu/items/order').send({ categoryId: catId, ids: ['nope'] }).expect(400);
    });

    it('reorders categories', async () => {
      const cats = (await ctx.owner.get('/admin/menu')).body.categories as { id: string }[];
      const reversed = [...cats].reverse().map((c) => c.id);
      await ctx.owner.put('/admin/menu/categories/order').send({ ids: reversed }).expect(200);
      expect((await ctx.owner.get('/admin/menu')).body.categories.map((c: { id: string }) => c.id)).toEqual(reversed);
      await ctx.owner.put('/admin/menu/categories/order').send({ ids: [...reversed].reverse() }).expect(200); // restore
    });

    it('archiving hides items and categories publicly and blocks ordering them', async () => {
      await ctx.owner.patch(`/admin/menu/items/${itemId}`).send({ isArchived: true }).expect(200);
      expect((await publicMenu()).find((c) => c.id === catId)?.items.map((i) => i.id) ?? []).not.toContain(itemId);
      expect((await quote(itemId)).body.issues[0].code).toBe('NOT_FOUND');
      await ctx.owner.patch(`/admin/menu/categories/${catId}`).send({ isArchived: true }).expect(200);
      expect((await publicMenu()).map((c) => c.id)).not.toContain(catId);
      expect((await ctx.owner.get('/admin/menu')).body.categories.some((c: { id: string }) => c.id === catId)).toBe(true); // still restorable
      await ctx.owner.post('/admin/menu/items').send({ categoryId: catId, name: 'E2E In archived', priceCents: 100 }).expect(400);
      await ctx.owner.patch(`/admin/menu/categories/${catId}`).send({ isArchived: false }).expect(200);
    });

    it('attaches an uploaded image to an item', async () => {
      const img = (await ctx.owner.post('/admin/media').field('altText', 'Tray').attach('file', PNG, 'tray.png').expect(201)).body;
      media.push(img.id);
      const r = await ctx.owner.patch(`/admin/menu/items/${itemId}`).send({ imageId: img.id }).expect(200);
      expect(r.body).toMatchObject({ imageUrl: img.url, imageAlt: 'Tray' });
      await ctx.owner.patch(`/admin/menu/items/${itemId}`).send({ imageId: null }).expect(200);
    });
  });

  describe('announcements (What\'s New)', () => {
    const publicNews = async () => ((await ctx.api().get('/api/v1/announcements')).body.announcements as { id: string; title: string }[]).map((a) => a.title);

    it('is invisible while draft, visible when published, hidden again when unpublished', async () => {
      const a = (await ctx.owner.post('/admin/announcements').send({ title: 'E2E Diwali special', body: 'Sweet boxes', linkUrl: '/menu' }).expect(201)).body;
      expect(a.status).toBe('DRAFT');
      expect(await publicNews()).not.toContain('E2E Diwali special');
      await ctx.owner.patch(`/admin/announcements/${a.id}`).send({ status: 'PUBLISHED' }).expect(200);
      expect(await publicNews()).toContain('E2E Diwali special');
      await ctx.owner.patch(`/admin/announcements/${a.id}`).send({ status: 'DRAFT' }).expect(200);
      expect(await publicNews()).not.toContain('E2E Diwali special');
      await ctx.owner.patch(`/admin/announcements/${a.id}`).send({ status: 'PUBLISHED' }).expect(200);
      await ctx.owner.patch(`/admin/announcements/${a.id}`).send({ status: 'ARCHIVED' }).expect(200);
      expect(await publicNews()).not.toContain('E2E Diwali special');
    });

    it('honours a scheduled publish time', async () => {
      const future = new Date(Date.now() + 3_600_000).toISOString();
      const a = (await ctx.owner.post('/admin/announcements').send({ title: 'E2E Scheduled', status: 'PUBLISHED', publishAt: future }).expect(201)).body;
      expect(await publicNews()).not.toContain('E2E Scheduled');
      await ctx.owner.patch(`/admin/announcements/${a.id}`).send({ publishAt: new Date(Date.now() - 1000).toISOString() }).expect(200);
      expect(await publicNews()).toContain('E2E Scheduled');
      await ctx.owner.patch(`/admin/announcements/${a.id}`).send({ publishAt: null }).expect(200);
    });

    it('validates input, including unsafe links', async () => {
      await ctx.owner.post('/admin/announcements').send({ title: '' }).expect(400);
      await ctx.owner.post('/admin/announcements').send({ title: 'E2E bad', linkUrl: 'javascript:alert(1)' }).expect(400);
      await ctx.owner.post('/admin/announcements').send({ title: 'E2E bad', linkUrl: '//evil.example' }).expect(400);
      await ctx.owner.post('/admin/announcements').send({ title: 'E2E bad', publishAt: 'tomorrow' }).expect(400);
      await ctx.owner.post('/admin/announcements').send({ title: 'E2E bad', imageId: 'missing' }).expect(400);
      await ctx.owner.post('/admin/announcements').send({ title: 'E2E ok', linkUrl: 'https://example.com/event' }).expect(201);
    });

    it('PATCH keeps unspecified fields and reorders', async () => {
      const list = (await ctx.owner.get('/admin/announcements')).body.announcements as { id: string; title: string }[];
      const mine = list.filter((x) => x.title.startsWith('E2E '));
      const first = mine[0];
      const before = (await ctx.owner.get('/admin/announcements')).body.announcements.find((x: { id: string }) => x.id === first.id);
      const r = await ctx.owner.patch(`/admin/announcements/${first.id}`).send({ title: `${first.title}!` }).expect(200);
      expect(r.body.body).toBe(before.body);
      expect(r.body.linkUrl).toBe(before.linkUrl);
      const ids = list.map((x) => x.id);
      await ctx.owner.put('/admin/announcements/order').send({ ids: [...ids].reverse() }).expect(200);
      expect((await ctx.owner.get('/admin/announcements')).body.announcements.map((x: { id: string }) => x.id)).toEqual([...ids].reverse());
      await ctx.owner.put('/admin/announcements/order').send({ ids }).expect(200);
    });
  });

  describe('pages and SEO', () => {
    const body = (over: object = {}) => ({ content: { intro: 'Hand-made daily.' }, seo: { title: 'Our Menu', description: 'Dishes from Maharashtra and Gujarat.', imageUrl: null, canonicalUrl: null, noIndex: false }, ...over });

    it('serves content publicly, with safe defaults when nothing is saved', async () => {
      await ctx.prisma.page.deleteMany({ where: { key: 'contact' } });
      const r = await ctx.api().get('/api/v1/pages/contact').expect(200);
      expect(r.body).toEqual({ key: 'contact', content: {}, seo: { title: null, description: null, imageUrl: null, canonicalUrl: null, noIndex: false } });
      await ctx.api().get('/api/v1/pages/nonsense').expect(404);
      await ctx.api().get('/api/v1/pages/..%2fsettings').expect(404);
    });

    it('saves page content and SEO, and the public endpoint reflects it', async () => {
      await ctx.owner.put('/admin/pages/menu').send(body()).expect(200);
      const r = (await ctx.api().get('/api/v1/pages/menu').expect(200)).body;
      expect(r.content).toEqual({ intro: 'Hand-made daily.' });
      expect(r.seo).toMatchObject({ title: 'Our Menu', description: 'Dishes from Maharashtra and Gujarat.', noIndex: false });
    });

    it('validates SEO on the server', async () => {
      const bad = (seo: object) => ctx.owner.put('/admin/pages/menu').send({ content: { intro: 'x' }, seo: { title: null, description: null, imageUrl: null, canonicalUrl: null, noIndex: false, ...seo } });
      await bad({ title: 'x'.repeat(71) }).expect(400);
      await bad({ description: 'x'.repeat(201) }).expect(400);
      await bad({ canonicalUrl: 'javascript:alert(1)' }).expect(400);
      await bad({ canonicalUrl: 'not a url' }).expect(400);
      await bad({ imageUrl: 'data:text/html,<script>' }).expect(400);
      await bad({ imageUrl: '//evil.example/x.png' }).expect(400);
      const ok = await bad({ canonicalUrl: 'https://shreefoods.example/menu', imageUrl: '/api/v1/uploads/abc.png', noIndex: true }).expect(200);
      expect(ok.body.seo.noIndex).toBe(true);
      await bad({ noIndex: false }).expect(200);
    });

    it('lets the Our Story picture be chosen, validates its address, and falls back when removed', async () => {
      const seo = { title: null, description: null, imageUrl: null, canonicalUrl: null, noIndex: false };
      const story = (extra: object) => ctx.owner.put('/admin/pages/story').send({ content: { headline: 'Our roots', paragraphs: ['One.'], ...extra }, seo });
      try {
        await story({ imageUrl: 'javascript:alert(1)' }).expect(400);
        await story({ imageUrl: '//evil.example/x.png' }).expect(400);
        await story({ imageUrl: 'https://pub-x.r2.dev/shreefoods/a.jpg', imageAlt: 'Our kitchen' }).expect(200);
        expect((await ctx.api().get('/api/v1/pages/story').expect(200)).body.content).toMatchObject({ imageUrl: 'https://pub-x.r2.dev/shreefoods/a.jpg', imageAlt: 'Our kitchen' });
        await story({}).expect(200); // saved without a picture: back to the one that ships with the website
        expect((await ctx.api().get('/api/v1/pages/story').expect(200)).body.content).toMatchObject({ imageUrl: null, imageAlt: '' });
      } finally {
        await ctx.prisma.page.deleteMany({ where: { key: 'story' } });
      }
    });

    it('validates page content per page, reporting field paths', async () => {
      const r = await ctx.owner.put('/admin/pages/story').send({ content: { headline: '', paragraphs: [] }, seo: { title: null, description: null, imageUrl: null, canonicalUrl: null, noIndex: false } }).expect(400);
      expect(r.body.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['content.headline', 'content.paragraphs']));
      await ctx.owner.put('/admin/pages/reviews').send({ content: { intro: '', links: [{ platform: 'Google', url: 'javascript:alert(1)' }] }, seo: { title: null, description: null, imageUrl: null, canonicalUrl: null, noIndex: false } }).expect(400);
      await ctx.owner.put('/admin/pages/nonsense').send(body()).expect(400);
      await ctx.owner.put('/admin/pages/menu').send({}).expect(400);
    });
  });

  describe('site settings', () => {
    const current = async () => (await ctx.owner.get('/admin/settings').expect(200)).body;
    // Sends the current settings with some fields overridden. `.expect(status)` mirrors supertest.
    const save = (over: object) => ({
      expect: async (status: number) => {
        const { paymentQrUrl, paymentQrAlt, deliveryEnabled, ...rest } = await current();
        void paymentQrUrl; void paymentQrAlt; void deliveryEnabled;
        return ctx.owner.put('/admin/settings').send({ ...rest, ...over }).expect(status);
      },
    });

    it('changes the tax rate, and checkout uses it straight away', async () => {
      const item = await ctx.prisma.menuItem.findFirstOrThrow({ where: { isAvailable: true, isArchived: false } });
      await save({ taxRateBps: 1000 }).expect(200);
      const q = (await quote(item.id)).body;
      expect(q.taxRateBps).toBe(1000);
      expect(q.taxCents).toBe(Math.floor((item.priceCents * 1000 + 5000) / 10000));
    });

    it('updates public restaurant info and hours', async () => {
      await save({ phone: '(555) 999-0000', openingHours: [{ day: 'Every day', hours: '9 AM - 9 PM' }], socialLinks: [{ label: 'Instagram', url: 'https://instagram.com/shreefoods' }] }).expect(200);
      const site = (await ctx.api().get('/api/v1/site').expect(200)).body;
      expect(site).toMatchObject({ phone: '(555) 999-0000', openingHours: [{ day: 'Every day', hours: '9 AM - 9 PM' }] });
    });

    it('validates settings', async () => {
      await save({ taxRateBps: 2501 }).expect(400);
      await save({ taxRateBps: -1 }).expect(400);
      await save({ taxRateBps: 8.25 }).expect(400);
      await save({ email: 'not-an-email' }).expect(400);
      await save({ socialLinks: [{ label: 'x', url: 'javascript:alert(1)' }] }).expect(400);
      await save({ pickupEnabled: false, dineInEnabled: false }).expect(400); // must offer at least one way to order
      await save({ restaurantName: '' }).expect(400);
    });

    it('can only point the payment QR at an image that exists, and delivery cannot be switched on', async () => {
      await save({ paymentQrId: 'missing' }).expect(400);
      const img = (await ctx.owner.post('/admin/media').field('altText', 'PayPal QR').attach('file', PNG, 'qr.png').expect(201)).body;
      media.push(img.id);
      const r = await save({ paymentQrId: img.id, paymentHandle: 'paypal.me/real', deliveryEnabled: true }).expect(200);
      expect(r.body).toMatchObject({ paymentQrId: img.id, paymentQrUrl: img.url, paymentHandle: 'paypal.me/real', deliveryEnabled: false });
      const o = await ctx.api().post('/api/v1/orders').send({ customerName: 'QR Test', customerEmail: 'e2e-cms@orders.example', customerPhone: '(555)010-2030', fulfillmentType: 'PICKUP', idempotencyKey: 'cmsqrtest0123456789abcdef', items: [{ menuItemId: (await ctx.prisma.menuItem.findFirstOrThrow({ where: { isAvailable: true, isArchived: false } })).id, quantity: 1 }] }).expect(201);
      const view = (await ctx.api().get(`/api/v1/orders/${o.body.token}`).expect(200)).body;
      expect(view.payment).toMatchObject({ qrUrl: img.url, handle: 'paypal.me/real' }); // customers see the new QR
      await ctx.prisma.order.deleteMany({ where: { customerEmail: 'e2e-cms@orders.example' } });
      await ctx.prisma.siteSettings.update({ where: { id: 'singleton' }, data: { paymentQrId: originalSettings.paymentQrId } });
    });
  });
});
