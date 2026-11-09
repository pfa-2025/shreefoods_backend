import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { MAX_LINE_QUANTITY, Totals, computeTotals } from '../pricing/pricing';
import { PrismaService } from '../prisma/prisma.service';

/** The client sends only ids and quantities. Anything else (e.g. a price) is stripped. */
export const quoteSchema = z.object({
  items: z
    .array(
      z.object({
        menuItemId: z.string().min(1).max(64),
        quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
      }),
    )
    .max(50),
});
export type QuoteInput = z.infer<typeof quoteSchema>;

export interface QuoteLine {
  menuItemId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  imageAlt: string;
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export type QuoteIssueCode = 'NOT_FOUND' | 'UNAVAILABLE';
export interface QuoteIssue {
  menuItemId: string;
  code: QuoteIssueCode;
  name?: string;
}

export interface Quote extends Totals {
  lines: QuoteLine[];
  /** Items that were dropped from the totals; the UI must tell the customer. */
  issues: QuoteIssue[];
  taxRateBps: number;
  ordersOpen: boolean;
  /** True only when every requested item is purchasable and the cart is not empty. */
  canCheckout: boolean;
}

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  /** Authoritative pricing from the database. Reused by order creation in Module 4. */
  async quote(input: QuoteInput): Promise<Quote> {
    // Merge duplicate ids so the same item can't dodge the per-line quantity cap.
    const wanted = new Map<string, number>();
    for (const i of input.items) {
      wanted.set(i.menuItemId, Math.min((wanted.get(i.menuItemId) ?? 0) + i.quantity, MAX_LINE_QUANTITY));
    }

    const [rows, settings] = await Promise.all([
      this.prisma.menuItem.findMany({
        where: { id: { in: [...wanted.keys()] } },
        include: { image: true, category: true },
      }),
      this.prisma.siteSettings.findUnique({ where: { id: 'singleton' } }),
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const lines: QuoteLine[] = [];
    const issues: QuoteIssue[] = [];
    for (const [id, quantity] of wanted) {
      const item = byId.get(id);
      if (!item || item.isArchived || item.category.isArchived) {
        issues.push({ menuItemId: id, code: 'NOT_FOUND' });
      } else if (!item.isAvailable) {
        issues.push({ menuItemId: id, code: 'UNAVAILABLE', name: item.name });
      } else {
        lines.push({
          menuItemId: item.id,
          name: item.name,
          slug: item.slug,
          imageUrl: item.image?.url ?? null,
          imageAlt: item.image?.altText ?? item.name,
          unitPriceCents: item.priceCents,
          quantity,
          lineTotalCents: item.priceCents * quantity,
        });
      }
    }

    const taxRateBps = settings?.taxRateBps ?? 0;
    // Menu-only mode (cartEnabled off) also blocks orders, so a hidden cart can't be bypassed by calling the API.
    const ordersOpen = (settings?.ordersOpen ?? true) && (settings?.cartEnabled ?? true);
    const totals = computeTotals(lines, taxRateBps);
    return {
      ...totals,
      lines,
      issues,
      taxRateBps,
      ordersOpen,
      canCheckout: lines.length > 0 && issues.length === 0 && ordersOpen,
    };
  }
}
