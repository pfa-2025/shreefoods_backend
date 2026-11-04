/** "Chicken Tikka (Spicy)!" -> "chicken-tikka-spicy" */
export function slugify(input: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || 'item';
}

/** Appends -2, -3 … until `taken` says the slug is free. */
export async function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  const root = slugify(base);
  let candidate = root;
  for (let n = 2; await taken(candidate); n++) candidate = `${root}-${n}`;
  return candidate;
}
