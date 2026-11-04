/** Plain, accessible transactional emails. Every customer-supplied value goes through esc(). */

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
export const orderRef = (n: number): string => `SF-${String(n).padStart(4, '0')}`;

export type TemplateName = 'order_received' | 'payment_confirmed' | 'payment_not_received' | 'order_accepted' | 'order_ready' | 'order_cancelled' | 'password_reset';

export interface OrderCtx {
  restaurantName: string;
  restaurantPhone: string | null;
  restaurantAddress: string | null;
  customerName: string;
  orderNumber: number;
  items: { name: string; quantity: number; lineTotalCents: number }[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  statusUrl: string;
  fulfillmentType: 'PICKUP' | 'DINE_IN' | 'DELIVERY';
  cancelReason?: string | null;
  refunded?: boolean;
}

interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const BRAND = '#1f3d2f';

function layout(restaurant: string, heading: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(heading)}</title></head>
<body style="margin:0;background:#f8f4ea;font-family:Georgia,'Times New Roman',serif;color:#2b2a28">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffdf8;border:1px solid #e3dccb;border-radius:6px">
<tr><td style="padding:24px 28px;border-bottom:1px solid #e3dccb"><span style="font-size:22px;color:${BRAND}">${esc(restaurant)}</span></td></tr>
<tr><td style="padding:28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55">
<h1 style="margin:0 0 16px;font-family:Georgia,serif;font-weight:normal;font-size:24px;color:${BRAND}">${esc(heading)}</h1>
${bodyHtml}
</td></tr></table>
<p style="font-family:Arial,sans-serif;font-size:12px;color:#7a766d;max-width:520px">This is a service message about your order from ${esc(restaurant)}. We don’t send marketing emails.</p>
</td></tr></table></body></html>`;
}

const button = (url: string, label: string) =>
  `<p style="margin:24px 0"><a href="${esc(url)}" style="background:${BRAND};color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;display:inline-block">${esc(label)}</a></p><p style="font-size:13px;color:#7a766d">Or copy this link: ${esc(url)}</p>`;

function summaryHtml(c: OrderCtx): string {
  const rows = c.items.map((i) => `<tr><td style="padding:4px 0">${esc(i.quantity)} × ${esc(i.name)}</td><td align="right" style="padding:4px 0">${usd(i.lineTotalCents)}</td></tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e3dccb;margin-top:16px">${rows}
<tr><td style="padding-top:10px;color:#7a766d">Tax</td><td align="right" style="padding-top:10px;color:#7a766d">${usd(c.taxCents)}</td></tr>
<tr><td style="padding-top:6px;font-weight:bold">Total</td><td align="right" style="padding-top:6px;font-weight:bold">${usd(c.totalCents)}</td></tr></table>`;
}

function summaryText(c: OrderCtx): string {
  return [...c.items.map((i) => `  ${i.quantity} x ${i.name}  ${usd(i.lineTotalCents)}`), `  Tax  ${usd(c.taxCents)}`, `  Total  ${usd(c.totalCents)}`].join('\n');
}

const pickupLines = (c: OrderCtx): string[] => [c.restaurantAddress && `Address: ${c.restaurantAddress}`, c.restaurantPhone && `Phone: ${c.restaurantPhone}`].filter(Boolean) as string[];

export function renderOrderEmail(name: Exclude<TemplateName, 'password_reset'>, c: OrderCtx): Rendered {
  const ref = orderRef(c.orderNumber);
  const hi = `Hi ${c.customerName},`;
  const track = (extra: string) => `${extra}\n\nTrack your order: ${c.statusUrl}`;
  const out = (subject: string, heading: string, para: string, extraHtml = '', extraText = ''): Rendered => ({
    subject,
    html: layout(c.restaurantName, heading, `<p>${esc(hi)}</p><p>${para}</p>${extraHtml}${summaryHtml(c)}${button(c.statusUrl, 'View your order')}`),
    text: `${hi}\n\n${track(`${extraText ? `${extraText}\n\n` : ''}${summaryText(c)}`)}`,
  });

  switch (name) {
    case 'order_received':
      return {
        ...out(`We received your order ${ref}`, `Thanks, we’ve got your order ${ref}`, 'Your order is placed. <strong>Please pay using the QR code on your order page</strong>, then tap “I’ve paid”. We start preparing it as soon as we confirm your payment.'),
        text: `${hi}\n\nYour order ${ref} is placed. Please pay using the QR code on your order page, then tap "I've paid". We start preparing it as soon as we confirm your payment.\n\n${summaryText(c)}\n\nOrder page (payment QR and live status): ${c.statusUrl}`,
      };
    case 'payment_confirmed':
      return out(`Payment confirmed for order ${ref}`, 'Payment confirmed', 'We’ve received your payment. Thank you! We’ll let you know as soon as the kitchen accepts your order.');
    case 'payment_not_received':
      return out(`We couldn’t find your payment for order ${ref}`, 'We couldn’t find your payment', 'We couldn’t find a payment matching this order. Please check the amount and the account you paid, then tap “I’ve paid” again on your order page. If you need help, contact us.', `<p>${esc(pickupLines(c).join(' · '))}</p>`, pickupLines(c).join('\n'));
    case 'order_accepted':
      return out(`Order ${ref} is accepted`, 'Your order is accepted', 'The kitchen has accepted your order and will start preparing it. We’ll email you again when it’s ready.');
    case 'order_ready': {
      const where = c.fulfillmentType === 'PICKUP' ? 'is ready for pickup' : c.fulfillmentType === 'DINE_IN' ? 'is ready' : 'is ready';
      const lines = c.fulfillmentType === 'PICKUP' ? pickupLines(c) : [];
      return out(`Order ${ref} ${where}`, `Your order ${where}`, `Good news: your order ${where}. Please show your order number <strong>${esc(ref)}</strong> when you arrive.`, lines.length ? `<p>${esc(lines.join(' · '))}</p>` : '', lines.join('\n'));
    }
    case 'order_cancelled':
      return out(
        `Order ${ref} was cancelled`,
        'Your order was cancelled',
        `We’re sorry: your order was cancelled${c.cancelReason ? `. Reason: ${esc(c.cancelReason)}` : '.'} ${c.refunded ? '<strong>Your payment has been refunded</strong> to the account you paid from. It can take a few days to appear.' : 'No payment was taken for this order.'}`,
        '',
        c.cancelReason ? `Reason: ${c.cancelReason}\n${c.refunded ? 'Your payment has been refunded.' : 'No payment was taken.'}` : c.refunded ? 'Your payment has been refunded.' : 'No payment was taken.',
      );
  }
}

export function renderPasswordReset(restaurantName: string, resetUrl: string): Rendered {
  return {
    subject: `Reset your ${restaurantName} admin password`,
    html: layout(restaurantName, 'Reset your password', `<p>Someone asked to reset the password for your admin account. If that was you, use the button below. The link works once and expires in one hour.</p>${button(resetUrl, 'Choose a new password')}<p style="font-size:13px;color:#7a766d">If you didn’t ask for this, you can ignore this email. Your password won’t change.</p>`),
    text: `Someone asked to reset the password for your admin account. If that was you, open this link (works once, expires in one hour):\n\n${resetUrl}\n\nIf you didn't ask for this, ignore this email. Your password won't change.`,
  };
}
