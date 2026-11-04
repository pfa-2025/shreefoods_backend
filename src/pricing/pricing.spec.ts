import { computeTax, computeTotals } from './pricing';

describe('pricing', () => {
  it('sums lines in integer cents', () => {
    const t = computeTotals(
      [
        { unitPriceCents: 700, quantity: 2 },
        { unitPriceCents: 1350, quantity: 1 },
      ],
      0,
    );
    expect(t).toEqual({ subtotalCents: 2750, taxCents: 0, feeCents: 0, totalCents: 2750 });
  });

  it('applies tax in basis points', () => {
    // 8.25% of $27.50 = 226.875 -> 227 cents (half up)
    expect(computeTax(2750, 825)).toBe(227);
  });

  it('rounds half up at the boundary and never produces fractions', () => {
    expect(computeTax(10, 500)).toBe(1); // 0.5 -> 1
    expect(computeTax(9, 500)).toBe(0); // 0.45 -> 0
    expect(Number.isInteger(computeTax(1234567, 825))).toBe(true);
  });

  it('avoids floating point drift (0.1 + 0.2 style bugs)', () => {
    const t = computeTotals([{ unitPriceCents: 10, quantity: 3 }, { unitPriceCents: 20, quantity: 3 }], 0);
    expect(t.subtotalCents).toBe(90);
  });

  it('includes fees in the total', () => {
    expect(computeTotals([{ unitPriceCents: 1000, quantity: 1 }], 1000, 150).totalCents).toBe(1250);
  });

  it('returns zeros for an empty cart', () => {
    expect(computeTotals([], 825)).toEqual({ subtotalCents: 0, taxCents: 0, feeCents: 0, totalCents: 0 });
  });
});
