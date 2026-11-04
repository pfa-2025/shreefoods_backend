/** All money is integer cents. Tax rate is basis points (825 = 8.25%). */

export const MAX_LINE_QUANTITY = 20;

export interface PricedLine {
  unitPriceCents: number;
  quantity: number;
}

export interface Totals {
  subtotalCents: number;
  taxCents: number;
  feeCents: number;
  totalCents: number;
}

/** Integer-only, rounds half up. */
export function computeTax(subtotalCents: number, taxRateBps: number): number {
  return Math.floor((subtotalCents * taxRateBps + 5000) / 10000);
}

export function computeTotals(lines: PricedLine[], taxRateBps: number, feeCents = 0): Totals {
  const subtotalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
  const taxCents = computeTax(subtotalCents, taxRateBps);
  return { subtotalCents, taxCents, feeCents, totalCents: subtotalCents + taxCents + feeCents };
}
