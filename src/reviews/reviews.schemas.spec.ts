import { looksLikeContactDetails, moderateReviewSchema, publicName, submitReviewSchema } from './reviews.schemas';

describe('publicName', () => {
  it('shows first name plus last initial', () => {
    expect(publicName('Asha Patel')).toBe('Asha P.');
    expect(publicName('  yash   raj ')).toBe('yash R.');
    expect(publicName('Maria de la Cruz')).toBe('Maria C.');
  });
  it('handles a single name and empty input without ever failing', () => {
    expect(publicName('Cher')).toBe('Cher');
    expect(publicName('   ')).toBe('Customer');
  });
  it('is never longer than the limit', () => {
    expect(publicName('x'.repeat(100)).length).toBeLessThanOrEqual(40);
  });
});

describe('looksLikeContactDetails', () => {
  it('flags emails, links and phone numbers typed into a display name', () => {
    for (const bad of ['asha@example.com', 'http://x.co', 'www.site.com', '(201) 555-0123', '2015550123', 'call 20155 50123']) expect(looksLikeContactDetails(bad)).toBe(true);
    for (const ok of ['Asha P.', 'Asha', 'A. Patel', 'Mr. Rao 2nd']) expect(looksLikeContactDetails(ok)).toBe(false);
  });
});

describe('submitReviewSchema', () => {
  it('accepts whole-number ratings 1-5 only', () => {
    for (const r of [1, 2, 3, 4, 5]) expect(submitReviewSchema.safeParse({ rating: r }).success).toBe(true);
    for (const r of [0, 6, -1, 3.5, '5', null, NaN]) expect(submitReviewSchema.safeParse({ rating: r }).success).toBe(false);
  });
  it('treats blank comments as no comment and caps their length', () => {
    expect(submitReviewSchema.parse({ rating: 5, comment: '   ' }).comment).toBeUndefined();
    expect(submitReviewSchema.safeParse({ rating: 5, comment: 'x'.repeat(501) }).success).toBe(false);
    expect(submitReviewSchema.parse({ rating: 5, comment: ' Great! ' }).comment).toBe('Great!');
  });
  it('ignores unknown fields such as a smuggled status', () => {
    expect(submitReviewSchema.parse({ rating: 5, status: 'PUBLISHED' })).not.toHaveProperty('status');
  });
});

describe('moderateReviewSchema', () => {
  it('needs something to change and a valid status', () => {
    expect(moderateReviewSchema.safeParse({}).success).toBe(false);
    expect(moderateReviewSchema.safeParse({ status: 'DELETED' }).success).toBe(false);
    expect(moderateReviewSchema.safeParse({ status: 'PUBLISHED' }).success).toBe(true);
  });
  it('lets an empty reply clear it, but leaving it out keeps it', () => {
    expect(moderateReviewSchema.parse({ reply: '  ' }).reply).toBeNull();
    expect(moderateReviewSchema.parse({ status: 'HIDDEN' })).not.toHaveProperty('reply');
  });
});
