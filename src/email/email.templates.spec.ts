import { OrderCtx, esc, renderOrderEmail, renderPasswordReset, usd } from './email.templates';

const ctx = (over: Partial<OrderCtx> = {}): OrderCtx => ({
  restaurantName: 'Shree Foods', restaurantPhone: '(555) 010-2030', restaurantAddress: '1 Main St', customerName: 'Asha',
  orderNumber: 7, items: [{ name: 'Vada Pav', quantity: 2, lineTotalCents: 1400 }], subtotalCents: 1400, taxCents: 116, totalCents: 1516,
  statusUrl: 'http://localhost:3000/order/tok123', fulfillmentType: 'PICKUP', ...over,
});

describe('email templates', () => {
  it('escapes every customer-supplied value (no HTML/script injection)', () => {
    const evil = '<script>alert(1)</script>"\'&';
    const r = renderOrderEmail('order_cancelled', ctx({ customerName: evil, cancelReason: evil, items: [{ name: evil, quantity: 1, lineTotalCents: 100 }] }));
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(esc(evil)).toBe('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;');
  });

  it('puts the order number in subjects and the status link in every email, as html and text', () => {
    for (const n of ['order_received', 'payment_confirmed', 'payment_not_received', 'order_accepted', 'order_ready', 'order_cancelled'] as const) {
      const r = renderOrderEmail(n, ctx());
      expect(r.subject).toContain('SF-0007');
      expect(r.html).toContain('http://localhost:3000/order/tok123');
      expect(r.text).toContain('http://localhost:3000/order/tok123');
      expect(r.html).toContain('Total');
      expect(r.text).toContain('$15.16');
    }
  });

  it('formats money from integer cents', () => {
    expect(usd(1516)).toBe('$15.16');
    expect(usd(5)).toBe('$0.05');
  });

  it('ready-for-pickup includes where to collect; cancellation says whether money is coming back', () => {
    expect(renderOrderEmail('order_ready', ctx()).text).toContain('1 Main St');
    expect(renderOrderEmail('order_cancelled', ctx({ refunded: true, cancelReason: 'Out of stock' })).text).toMatch(/refunded/);
    expect(renderOrderEmail('order_cancelled', ctx({ refunded: false })).text).toMatch(/No payment was taken/);
  });

  it('never claims marketing and carries a plain-text alternative', () => {
    const r = renderOrderEmail('order_accepted', ctx());
    expect(r.html).toContain('We don’t send marketing emails');
    expect(r.text.length).toBeGreaterThan(40);
  });

  it('password reset has the link and a not-me note', () => {
    const r = renderPasswordReset('Shree Foods', 'http://x/reset?token=abc');
    expect(r.html).toContain('http://x/reset?token=abc');
    expect(r.text).toContain("didn't ask");
  });
});
