import { randomBytes } from 'node:crypto';
import { EmailProvider, OutgoingEmail } from '../src/email/email.provider';
import { EmailService, MAX_ATTEMPTS } from '../src/email/email.service';
import { boot } from './cms-helpers';

const CUSTOMER = 'e2e-mail@orders.example';

class FakeProvider extends EmailProvider {
  name: 'resend' | 'log' = 'resend';
  sent: { msg: OutgoingEmail; key: string }[] = [];
  failures = 0; // fail this many sends, then recover
  send(msg: OutgoingEmail, key: string): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new Error('provider unavailable'));
    }
    this.sent.push({ msg, key });
    return Promise.resolve();
  }
}

describe('Transactional email (e2e, requires seeded db)', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  const fake = new FakeProvider();
  let email: EmailService;
  let itemId: string;

  const sentTo = (to: string) => fake.sent.filter((s) => s.msg.to === to);
  const waitFor = async (pred: () => boolean | Promise<boolean>, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out waiting for condition');
  };
  const place = async (over: Record<string, unknown> = {}) => {
    const res = await ctx.api().post('/api/v1/orders').send({
      customerName: 'Asha Patel', customerEmail: CUSTOMER, customerPhone: '(555)010-2030', fulfillmentType: 'PICKUP',
      idempotencyKey: randomBytes(16).toString('hex'), items: [{ menuItemId: itemId, quantity: 2 }], ...over,
    }).expect(201);
    const o = await ctx.prisma.order.findUniqueOrThrow({ where: { publicToken: res.body.token } });
    return { id: o.id, token: res.body.token as string, number: o.orderNumber };
  };
  const templates = () => fake.sent.map((s) => s.msg.subject);
  const logsFor = (orderId: string) => ctx.prisma.emailLog.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ctx = await boot('e2e-mail', (b) => b.overrideProvider(EmailProvider).useValue(fake));
    email = ctx.app.get(EmailService);
    itemId = (await ctx.prisma.menuItem.findUniqueOrThrow({ where: { slug: 'vada-pav' } })).id;
  });
  beforeEach(() => {
    fake.sent = [];
    fake.failures = 0;
    fake.name = 'resend';
  });
  afterAll(async () => {
    await ctx.prisma.emailLog.deleteMany({ where: { OR: [{ toEmail: CUSTOMER }, { toEmail: { endsWith: '@admin.example' } }] } });
    await ctx.prisma.order.deleteMany({ where: { customerEmail: CUSTOMER } });
    await ctx.close();
  });

  it('emails the customer at each step of a normal order, and stays quiet on the rest', async () => {
    const o = await place();
    await waitFor(() => sentTo(CUSTOMER).length === 1);
    const first = sentTo(CUSTOMER)[0];
    expect(first.msg.subject).toBe(`We received your order SF-${String(o.number).padStart(4, '0')}`);
    expect(first.msg.html).toContain(`/order/${o.token}`); // link to the secured status page
    expect(first.msg.text).toContain(`/order/${o.token}`);
    expect(first.msg.html).toContain('Vada Pav');

    // the customer's own "I've paid" and staff acknowledging do not email anyone
    await ctx.api().post(`/api/v1/orders/${o.token}/report-payment`).send({}).expect(200);
    await ctx.owner.post(`/admin/orders/${o.id}/acknowledge`).expect(200);

    await ctx.owner.post(`/admin/orders/${o.id}/verify-payment`).expect(200);
    await waitFor(() => templates().some((s) => s.startsWith('Payment confirmed')));
    await ctx.owner.post(`/admin/orders/${o.id}/status`).send({ status: 'ACCEPTED' }).expect(200);
    await waitFor(() => templates().some((s) => s.endsWith('is accepted')));
    await ctx.owner.post(`/admin/orders/${o.id}/status`).send({ status: 'PREPARING' }).expect(200);
    await ctx.owner.post(`/admin/orders/${o.id}/status`).send({ status: 'READY' }).expect(200);
    await waitFor(() => templates().some((s) => s.endsWith('is ready for pickup')));
    await ctx.owner.post(`/admin/orders/${o.id}/status`).send({ status: 'COMPLETED' }).expect(200);

    await new Promise((r) => setTimeout(r, 300)); // give any wrongly-triggered email time to appear
    expect(templates()).toEqual([
      expect.stringMatching(/^We received your order/),
      expect.stringMatching(/^Payment confirmed/),
      expect.stringMatching(/is accepted$/),
      expect.stringMatching(/is ready for pickup$/),
    ]);
    expect(fake.sent.every((s) => s.msg.to === CUSTOMER)).toBe(true);
    expect(fake.sent.find((s) => s.msg.subject.endsWith('is ready for pickup'))?.msg.text).toContain('Example Street'); // where to collect
    const logs = await logsFor(o.id);
    expect(logs.map((l) => [l.template, l.status, l.attempts])).toEqual([
      ['order_received', 'SENT', 1], ['payment_confirmed', 'SENT', 1], ['order_accepted', 'SENT', 1], ['order_ready', 'SENT', 1],
    ]);
    expect(logs.every((l) => l.sentAt && l.provider === 'resend')).toBe(true);
  });

  it('sends exactly one email per event, even if the event is delivered again', async () => {
    const o = await place();
    await waitFor(() => sentTo(CUSTOMER).length === 1);
    const created = await ctx.prisma.orderEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'ORDER_CREATED' } });
    const live = ctx.app.get((await import('../src/live/live-events.service')).LiveEventsService);
    for (let i = 0; i < 4; i++) await live.publish(created.id); // replays / retries
    await new Promise((r) => setTimeout(r, 300));
    expect(sentTo(CUSTOMER)).toHaveLength(1);
    expect(await ctx.prisma.emailLog.count({ where: { orderId: o.id } })).toBe(1);
    expect(fake.sent[0].key).toBe(`${created.id}:order_received`); // the provider also gets an idempotency key
  });

  it('cancellation: one email, with the reason, saying whether money is being returned', async () => {
    const unpaid = await place();
    await waitFor(() => sentTo(CUSTOMER).length === 1);
    await ctx.owner.post(`/admin/orders/${unpaid.id}/cancel`).send({ reason: 'Kitchen closed early' }).expect(200);
    await waitFor(() => sentTo(CUSTOMER).length === 2);
    expect(sentTo(CUSTOMER)[1].msg.text).toContain('Kitchen closed early');
    expect(sentTo(CUSTOMER)[1].msg.text).toMatch(/No payment was taken/);

    fake.sent = [];
    const paid = await place();
    await ctx.api().post(`/api/v1/orders/${paid.token}/report-payment`).send({}).expect(200);
    await ctx.owner.post(`/admin/orders/${paid.id}/verify-payment`).expect(200);
    await ctx.owner.post(`/admin/orders/${paid.id}/cancel`).send({ reason: 'Out of <b>stock</b>', refundIssued: true }).expect(200);
    await waitFor(() => templates().some((s) => s.endsWith('was cancelled')));
    const cancelled = fake.sent.filter((s) => s.msg.subject.endsWith('was cancelled'));
    expect(cancelled).toHaveLength(1); // cancel + refund events -> a single email
    expect(cancelled[0].msg.text).toMatch(/refunded/);
    expect(cancelled[0].msg.html).toContain('Out of &lt;b&gt;stock&lt;/b&gt;'); // reason is escaped
  });

  it('tells the customer when a reported payment was not found, each time it happens', async () => {
    const o = await place();
    await ctx.api().post(`/api/v1/orders/${o.token}/report-payment`).send({}).expect(200);
    await ctx.owner.post(`/admin/orders/${o.id}/reject-payment`).send({ reason: 'wrong amount' }).expect(200);
    await waitFor(() => templates().some((s) => s.startsWith("We couldn’t find your payment")));
    await ctx.api().post(`/api/v1/orders/${o.token}/report-payment`).send({}).expect(200);
    await ctx.owner.post(`/admin/orders/${o.id}/reject-payment`).send({}).expect(200);
    await waitFor(() => templates().filter((s) => s.startsWith("We couldn’t find your payment")).length === 2);
  });

  it('never lets customer-supplied text inject markup into an email', async () => {
    await place({ customerName: '<script>alert(1)</script> Eve' });
    await waitFor(() => sentTo(CUSTOMER).length === 1);
    expect(sentTo(CUSTOMER)[0].msg.html).not.toContain('<script>');
    expect(sentTo(CUSTOMER)[0].msg.html).toContain('&lt;script&gt;');
  });

  describe('delivery problems', () => {
    it('records the failure, retries later, and delivers once the provider recovers', async () => {
      fake.failures = 2;
      const o = await place();
      await waitFor(async () => (await logsFor(o.id))[0]?.attempts === 1 && (await logsFor(o.id))[0]?.error !== null);
      let log = (await logsFor(o.id))[0];
      expect(log).toMatchObject({ status: 'QUEUED', attempts: 1, error: 'provider unavailable' });
      expect(log.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now()); // backing off, not hammering the provider
      expect(fake.sent).toHaveLength(0);

      await email.sweep(); // not due yet: nothing happens
      expect(fake.sent).toHaveLength(0);

      await ctx.prisma.emailLog.update({ where: { id: log.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await email.sweep(); // second failure
      log = (await logsFor(o.id))[0];
      expect(log).toMatchObject({ status: 'QUEUED', attempts: 2 });

      await ctx.prisma.emailLog.update({ where: { id: log.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await email.sweep(); // provider recovered
      log = (await logsFor(o.id))[0];
      expect(log).toMatchObject({ status: 'SENT', attempts: 3, error: null });
      expect(fake.sent).toHaveLength(1);
    });

    it('gives up after the maximum attempts, shows FAILED, and staff can retry it', async () => {
      fake.failures = 99;
      const o = await place();
      await waitFor(async () => ((await logsFor(o.id))[0]?.attempts ?? 0) >= 1);
      for (let i = 1; i < MAX_ATTEMPTS; i++) {
        await ctx.prisma.emailLog.updateMany({ where: { orderId: o.id, status: 'QUEUED' }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
        await email.sweep();
      }
      const failed = (await logsFor(o.id))[0];
      expect(failed).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS });
      expect(failed.nextAttemptAt).toBeNull();

      const list = await ctx.staff.get(`/admin/orders/${o.id}/emails`).expect(200); // staff can see it
      expect(list.body.emails[0]).toMatchObject({ template: 'order_received', status: 'FAILED', attempts: MAX_ATTEMPTS });

      fake.failures = 0;
      expect((await ctx.staff.post(`/admin/emails/${failed.id}/retry`).expect(200)).body.retried).toBe(true);
      expect((await logsFor(o.id))[0]).toMatchObject({ status: 'SENT' });
      expect((await ctx.staff.post(`/admin/emails/${failed.id}/retry`).expect(200)).body.retried).toBe(false); // already sent: no double send
      expect(fake.sent).toHaveLength(1);
    });

    it('a failing email provider never breaks the order or the staff action', async () => {
      fake.failures = 99;
      const o = await place();
      await ctx.api().post(`/api/v1/orders/${o.token}/report-payment`).send({}).expect(200);
      await ctx.owner.post(`/admin/orders/${o.id}/verify-payment`).expect(200);
      await ctx.owner.post(`/admin/orders/${o.id}/status`).send({ status: 'ACCEPTED' }).expect(200);
      expect((await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.id } })).fulfillmentStatus).toBe('ACCEPTED');
    });
  });

  describe('admin access', () => {
    it('requires a session', async () => {
      await ctx.api().get('/api/v1/admin/orders/x/emails').expect(401);
      await ctx.csrf(ctx.api().post('/api/v1/admin/emails/x/retry')).expect(401);
      await ctx.staff.post('/admin/emails/nope/retry').expect(404);
    });
  });

  describe('password reset email', () => {
    const ADMIN = 'e2e-mail-staff@admin.example'; // created by boot()
    const forgot = () => ctx.csrf(ctx.api().post('/api/v1/admin/auth/forgot-password')).send({ email: ADMIN });

    it('emails the link, once, without keeping the secret in the database', async () => {
      await forgot().expect(200);
      await waitFor(() => sentTo(ADMIN).length === 1);
      const m = sentTo(ADMIN)[0].msg;
      const token = /token=([A-Za-z0-9_-]+)/.exec(m.text)![1];
      expect(m.subject).toContain('Reset your');
      expect(m.html).toContain(`/admin/reset-password?token=${token}`);

      const log = await ctx.prisma.emailLog.findFirstOrThrow({ where: { toEmail: ADMIN, template: 'password_reset' } });
      expect(log.status).toBe('SENT');
      expect(log.payload).toBeNull(); // the link is a credential, so the message body isn't stored
      expect(JSON.stringify(log)).not.toContain(token);

      await ctx.csrf(ctx.api().post('/api/v1/admin/auth/reset-password')).send({ token, password: 'a-brand-new-password-9' }).expect(200); // and the emailed link works
    });

    it('does not email unknown addresses, and does not retry a failed reset email', async () => {
      await ctx.csrf(ctx.api().post('/api/v1/admin/auth/forgot-password')).send({ email: 'ghost@admin.example' }).expect(200);
      await new Promise((r) => setTimeout(r, 200));
      expect(sentTo('ghost@admin.example')).toHaveLength(0);

      fake.failures = 1;
      await forgot().expect(200);
      await waitFor(async () => (await ctx.prisma.emailLog.count({ where: { toEmail: ADMIN, template: 'password_reset', status: 'FAILED' } })) === 1);
      const failed = await ctx.prisma.emailLog.findFirstOrThrow({ where: { toEmail: ADMIN, status: 'FAILED' } });
      expect(failed).toMatchObject({ attempts: 1, nextAttemptAt: null });
      // (the staff session was ended by the completed password reset above, which is intended, so use the owner's)
      expect((await ctx.owner.post(`/admin/emails/${failed.id}/retry`).expect(200)).body.retried).toBe(false); // nothing stored to resend
    });
  });

  describe('customer order page', () => {
    it('is never cached, and says whether real emails are being sent', async () => {
      const o = await place();
      const real = await ctx.api().get(`/api/v1/orders/${o.token}`).expect(200);
      expect(real.headers['cache-control']).toBe('no-store');
      expect(real.body.emailsEnabled).toBe(true);
      fake.name = 'log';
      expect((await ctx.api().get(`/api/v1/orders/${o.token}`).expect(200)).body.emailsEnabled).toBe(false);
      const report = await ctx.api().post(`/api/v1/orders/${o.token}/report-payment`).send({}).expect(200);
      expect(report.headers['cache-control']).toBe('no-store');
    });
  });
});
