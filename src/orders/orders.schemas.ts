import { z } from 'zod';
import { quoteSchema } from '../cart/cart.service';

/** US phone: 10 digits (optional leading 1), area code not starting 0/1. Stored as +1XXXXXXXXXX. */
export function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{9}$/.test(ten) ? `+1${ten}` : null;
}

const emptyToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

export const createOrderSchema = z
  .object({
    customerName: z.string().trim().min(2, 'Enter your full name').max(80),
    customerEmail: z.string().trim().toLowerCase().email('Enter a valid email').max(254),
    customerPhone: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .max(30)
        .transform((v, ctx) => {
          const n = normalizeUsPhone(v);
          if (!n) ctx.addIssue({ code: 'custom', message: 'Enter a valid 10-digit US phone number' });
          return n ?? z.NEVER;
        })
        .optional(),
    ),
    fulfillmentType: z.enum(['PICKUP', 'DINE_IN', 'DELIVERY']),
    deliveryAddress: z.preprocess(emptyToUndefined, z.string().trim().min(5).max(300).optional()),
    notes: z.preprocess(emptyToUndefined, z.string().trim().max(500).optional()),
    idempotencyKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/),
    items: quoteSchema.shape.items.min(1, 'Your cart is empty'),
  })
  .superRefine((v, ctx) => {
    if (v.fulfillmentType !== 'DINE_IN' && !v.customerPhone) {
      ctx.addIssue({ code: 'custom', path: ['customerPhone'], message: 'Phone number is required for this order type' });
    }
    if (v.fulfillmentType === 'DELIVERY' && !v.deliveryAddress) {
      ctx.addIssue({ code: 'custom', path: ['deliveryAddress'], message: 'Delivery address is required' });
    }
  });
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const reportPaymentSchema = z.object({
  reference: z.preprocess(emptyToUndefined, z.string().trim().max(100).optional()),
});
export type ReportPaymentInput = z.infer<typeof reportPaymentSchema>;
