import { slugify, uniqueSlug } from './slug';

describe('slugify', () => {
  it('makes url-safe lowercase slugs', () => {
    expect(slugify('Chicken Tikka (Spicy)!')).toBe('chicken-tikka-spicy');
    expect(slugify('  Crème Brûlée ')).toBe('creme-brulee');
  });
  it('never returns an empty slug and caps the length', () => {
    expect(slugify('!!!')).toBe('item');
    expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(60);
  });
  it('neutralises path and script characters', () => {
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('<script>x</script>')).toBe('script-x-script');
  });
});

describe('uniqueSlug', () => {
  it('adds a numeric suffix until free', async () => {
    const taken = new Set(['vada-pav', 'vada-pav-2']);
    expect(await uniqueSlug('Vada Pav', async (s) => taken.has(s))).toBe('vada-pav-3');
    expect(await uniqueSlug('Misal', async (s) => taken.has(s))).toBe('misal');
  });
});
