import { randomBytes } from 'node:crypto';
import { boot } from './cms-helpers';

const CUSTOMER = 'e2e-review@orders.example';

describe('Customer reviews (e2e, requires seeded db)', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  let itemId: string;

  const place = async (name = 'Asha Patel') => {
    const res = await ctx.api().post('/api/v1/orders').send({
      customerName: name, customerEmail: CUSTOMER, customerPhone: '(555)010-2030', fulfillmentType: 'PICKUP',
      idempotencyKey: randomBytes(16).toString('hex'), items: [{ menuItemId: itemId, quantity: 1 }],
    }).expect(201);
    const o = await ctx.prisma.order.findUniqueOrThrow({ where: { publicToken: res.body.token } });
    return { id: o.id, token: res.body.token as string };
  };
  /** An order that has been paid for and is at the given stage (set directly: the staff workflow has its own tests). */
  const orderAt = async (status: 'PENDING_ACCEPTANCE' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'COMPLETED' | 'CANCELLED', name?: string) => {
    const o = await place(name);
    await ctx.prisma.order.update({ where: { id: o.id }, data: { paymentStatus: 'PAID', fulfillmentStatus: status } });
    return o;
  };
  const review = (token: string, body: unknown) => ctx.api().post(`/api/v1/orders/${token}/review`).send(body as object);
  const view = async (token: string) => (await ctx.api().get(`/api/v1/orders/${token}`).expect(200)).body;
  const publicReviews = async () => (await ctx.api().get('/api/v1/reviews').expect(200)).body;
  const adminList = async (qs = '') => (await ctx.owner.get(`/admin/reviews${qs}`).expect(200)).body;

  beforeAll(async () => {
    ctx = await boot('e2e-rev');
    itemId = (await ctx.prisma.menuItem.findUniqueOrThrow({ where: { slug: 'vada-pav' } })).id;
    await ctx.prisma.order.deleteMany({ where: { customerEmail: CUSTOMER } });
  });
  afterAll(async () => {
    await ctx.prisma.order.deleteMany({ where: { customerEmail: CUSTOMER } }); // reviews go with their orders
    await ctx.prisma.emailLog.deleteMany({ where: { toEmail: CUSTOMER } });
    await ctx.close();
  });

  describe('who can review, and when', () => {
    it('only once the order is ready, never before, never when cancelled', async () => {
      for (const stage of ['PENDING_ACCEPTANCE', 'ACCEPTED', 'PREPARING', 'CANCELLED'] as const) {
        const o = await orderAt(stage);
        expect((await view(o.token)).canReview).toBe(false);
        await review(o.token, { rating: 5 }).expect(409);
      }
      for (const stage of ['READY', 'COMPLETED'] as const) {
        const o = await orderAt(stage);
        expect((await view(o.token)).canReview).toBe(true);
        await review(o.token, { rating: 5, comment: 'Lovely' }).expect(201);
      }
    });

    it('works after a real run through the staff workflow', async () => {
      const o = await place();
      await ctx.api().post(`/api/v1/orders/${o.token}/report-payment`).send({}).expect(200);
      await ctx.owner.post(`/admin/orders/${o.id}/verify-payment`).expect(200);
      for (const status of ['ACCEPTED', 'PREPARING']) await ctx.owner.post(`/admin/orders/${o.id}/status`).send({ status }).expect(200);
      await review(o.token, { rating: 4 }).expect(409); // still cooking
      await ctx.owner.post(`/admin/orders/${o.id}/status`).send({ status: 'READY' }).expect(200);
      await review(o.token, { rating: 4 }).expect(201);
    });

    it('needs the order\'s private link: an unknown or made-up link cannot review', async () => {
      await review('not-a-real-token', { rating: 5 }).expect(404);
      await review('1', { rating: 5 }).expect(404);
    });

    it('allows exactly one review per order, even when submitted simultaneously', async () => {
      const o = await orderAt('COMPLETED');
      const results = await Promise.all(Array.from({ length: 6 }, () => review(o.token, { rating: 5, comment: 'Same review' })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(5);
      expect(await ctx.prisma.review.count({ where: { orderId: o.id } })).toBe(1);
      expect((await view(o.token)).canReview).toBe(false);
    });
  });

  describe('what can be submitted', () => {
    it('requires a whole-number rating from 1 to 5', async () => {
      const o = await orderAt('COMPLETED');
      for (const rating of [0, 6, -1, 3.5, '5', null, undefined]) await review(o.token, { rating }).expect(400);
      await review(o.token, {}).expect(400);
      expect(await ctx.prisma.review.count({ where: { orderId: o.id } })).toBe(0);
    });

    it('limits comment length and refuses contact details in the display name', async () => {
      const o = await orderAt('COMPLETED');
      await review(o.token, { rating: 5, comment: 'x'.repeat(501) }).expect(400);
      for (const displayName of ['me@example.com', 'call 2015550123', 'http://spam.example']) {
        const r = await review(o.token, { rating: 5, displayName }).expect(400);
        expect(JSON.stringify(r.body)).toContain('displayName');
      }
      await review(o.token, { rating: 5, comment: '   ' }).expect(201); // a rating alone is fine
    });

    it('shows first name + initial by default, or a name the customer chose; never the full name', async () => {
      const a = await orderAt('COMPLETED', 'Asha Patel');
      expect((await review(a.token, { rating: 5 }).expect(201)).body.displayName).toBe('Asha P.');
      const b = await orderAt('COMPLETED', 'Ravi Kumar');
      expect((await review(b.token, { rating: 5, displayName: 'Ravi' }).expect(201)).body.displayName).toBe('Ravi');
    });

    it('keeps markup as plain text (the website escapes it) and ignores a smuggled status', async () => {
      const o = await orderAt('COMPLETED');
      const r = await review(o.token, { rating: 5, comment: '<script>alert(1)</script> great', status: 'PUBLISHED' }).expect(201);
      expect(r.body.comment).toBe('<script>alert(1)</script> great');
      expect(r.body.visibility).toBe('received'); // not public: it still needs approval
      expect((await ctx.prisma.review.findUniqueOrThrow({ where: { orderId: o.id } })).status).toBe('PENDING');
    });
  });

  describe('the database protects itself too', () => {
    it('refuses ratings outside 1-5 and over-long comments even if code is bypassed', async () => {
      const o = await orderAt('COMPLETED');
      await expect(ctx.prisma.review.create({ data: { orderId: o.id, rating: 9, displayName: 'x' } })).rejects.toThrow();
      await expect(ctx.prisma.review.create({ data: { orderId: o.id, rating: 0, displayName: 'x' } })).rejects.toThrow();
      await expect(ctx.prisma.review.create({ data: { orderId: o.id, rating: 5, comment: 'x'.repeat(501), displayName: 'x' } })).rejects.toThrow();
    });
    it('removes a review with its order', async () => {
      const o = await orderAt('COMPLETED');
      await review(o.token, { rating: 5 }).expect(201);
      await ctx.prisma.order.delete({ where: { id: o.id } });
      expect(await ctx.prisma.review.count({ where: { orderId: o.id } })).toBe(0);
    });
  });

  describe('moderation by the owner', () => {
    it('keeps new reviews private until approved, then publishes without any personal details', async () => {
      const before = await publicReviews();
      const o = await orderAt('COMPLETED', 'Meera Shah');
      await review(o.token, { rating: 5, comment: 'Best dhokla in town' }).expect(201);

      expect(JSON.stringify(await publicReviews())).not.toContain('Best dhokla');
      expect((await publicReviews()).summary.count).toBe(before.summary.count);

      const pending = (await adminList('?status=PENDING')).reviews.find((r: { comment: string }) => r.comment === 'Best dhokla in town');
      expect(pending).toMatchObject({ status: 'PENDING', customerEmail: CUSTOMER, customerName: 'Meera Shah', displayName: 'Meera S.', rating: 5 });
      expect((await ctx.owner.get('/admin/dashboard').expect(200)).body.queue.reviewsToModerate).toBeGreaterThanOrEqual(1);

      await ctx.owner.patch(`/admin/reviews/${pending.id}`).send({ status: 'PUBLISHED' }).expect(200);
      const after = await publicReviews();
      const shown = after.reviews.find((r: { id: string }) => r.id === pending.id);
      expect(shown).toBeDefined();
      expect(Object.keys(shown).sort()).toEqual(['comment', 'createdAt', 'displayName', 'id', 'rating', 'repliedAt', 'reply']);
      expect(JSON.stringify(after)).not.toMatch(/e2e-review@|Meera Shah|555|publicToken|orderNumber|orderId/);
      expect(after.summary.count).toBe(before.summary.count + 1);
      expect((await view(o.token)).review).toMatchObject({ rating: 5, visibility: 'public' });
    });

    it('computes the average from published reviews only', async () => {
      const base = await publicReviews();
      const mk = async (rating: number, publish: boolean) => {
        const o = await orderAt('COMPLETED');
        await review(o.token, { rating, comment: `avg-test-${rating}-${publish}` }).expect(201);
        const row = await ctx.prisma.review.findUniqueOrThrow({ where: { orderId: o.id } });
        if (publish) await ctx.owner.patch(`/admin/reviews/${row.id}`).send({ status: 'PUBLISHED' }).expect(200);
      };
      await mk(1, false); // never published: must not drag the average down
      await mk(5, true);
      await mk(3, true);
      const now = await publicReviews();
      expect(now.summary.count).toBe(base.summary.count + 2);
      const sum = (r: { reviews: { rating: number }[] }) => r.reviews.reduce((s, x) => s + x.rating, 0);
      expect(now.summary.average).toBeCloseTo(Math.round((now.reviews.length ? sum(now) / now.reviews.length : 0) * 10) / 10, 1);
    });

    it('can hide a review again, and the customer is not told it was hidden', async () => {
      const o = await orderAt('COMPLETED');
      await review(o.token, { rating: 2, comment: 'hide-me' }).expect(201);
      const row = await ctx.prisma.review.findUniqueOrThrow({ where: { orderId: o.id } });
      await ctx.owner.patch(`/admin/reviews/${row.id}`).send({ status: 'PUBLISHED' }).expect(200);
      expect(JSON.stringify(await publicReviews())).toContain('hide-me');
      await ctx.owner.patch(`/admin/reviews/${row.id}`).send({ status: 'HIDDEN' }).expect(200);
      expect(JSON.stringify(await publicReviews())).not.toContain('hide-me');
      expect((await view(o.token)).review.visibility).toBe('received');
    });

    it('lets the owner reply publicly, change the reply, and remove it', async () => {
      const o = await orderAt('COMPLETED');
      await review(o.token, { rating: 4, comment: 'reply-test' }).expect(201);
      const row = await ctx.prisma.review.findUniqueOrThrow({ where: { orderId: o.id } });
      await ctx.owner.patch(`/admin/reviews/${row.id}`).send({ status: 'PUBLISHED', reply: 'Thank you, see you soon!' }).expect(200);
      const shown = () => publicReviews().then((p) => p.reviews.find((r: { id: string }) => r.id === row.id));
      expect(await shown()).toMatchObject({ reply: 'Thank you, see you soon!' });
      expect((await shown()).repliedAt).not.toBeNull();
      expect((await view(o.token)).review.reply).toBe('Thank you, see you soon!');
      await ctx.owner.patch(`/admin/reviews/${row.id}`).send({ status: 'PUBLISHED' }).expect(200); // status-only change keeps the reply
      expect(await shown()).toMatchObject({ reply: 'Thank you, see you soon!' });
      await ctx.owner.patch(`/admin/reviews/${row.id}`).send({ reply: '' }).expect(200);
      expect(await shown()).toMatchObject({ reply: null, repliedAt: null });
      await ctx.owner.patch(`/admin/reviews/${row.id}`).send({ reply: 'x'.repeat(501) }).expect(400);
      await ctx.owner.patch(`/admin/reviews/${row.id}`).send({}).expect(400);
      await ctx.owner.patch(`/admin/reviews/${row.id}`).send({ status: 'DELETED' }).expect(400);
    });

    it('deletes a review for good', async () => {
      const o = await orderAt('COMPLETED');
      await review(o.token, { rating: 1, comment: 'delete-me' }).expect(201);
      const row = await ctx.prisma.review.findUniqueOrThrow({ where: { orderId: o.id } });
      await ctx.owner.patch(`/admin/reviews/${row.id}`).send({ status: 'PUBLISHED' }).expect(200);
      await ctx.owner.delete(`/admin/reviews/${row.id}`).expect(204);
      expect(JSON.stringify(await publicReviews())).not.toContain('delete-me');
      await ctx.owner.delete(`/admin/reviews/${row.id}`).expect(404);
      await ctx.owner.patch(`/admin/reviews/${row.id}`).send({ status: 'PUBLISHED' }).expect(404);
    });

    it('filters and counts by status, and is owner-only', async () => {
      const list = await adminList();
      expect(list.counts).toEqual({ pending: expect.any(Number), published: expect.any(Number), hidden: expect.any(Number) });
      expect((await adminList('?status=HIDDEN')).reviews.every((r: { status: string }) => r.status === 'HIDDEN')).toBe(true);
      await ctx.owner.get('/admin/reviews?status=NOPE').expect(400);
      await ctx.staff.get('/admin/reviews').expect(403);
      await ctx.api().get('/api/v1/admin/reviews').expect(401);
      const row = (await adminList()).reviews[0];
      await ctx.staff.patch(`/admin/reviews/${row.id}`).send({ status: 'PUBLISHED' }).expect(403);
      await ctx.staff.delete(`/admin/reviews/${row.id}`).expect(403);
    });
  });
});
