import { PNG, boot } from './cms-helpers';

describe('Media library (e2e)', () => {
  let ctx: Awaited<ReturnType<typeof boot>>;
  const created: string[] = [];

  const upload = (who: 'owner' | 'staff', file: Buffer | string, name = 'photo.png', alt = 'A photo') =>
    ctx[who].post('/admin/media').field('altText', alt).attach('file', Buffer.isBuffer(file) ? file : Buffer.from(file), name);

  beforeAll(async () => {
    ctx = await boot('e2e-media');
  });
  afterAll(async () => {
    await ctx.prisma.mediaAsset.deleteMany({ where: { id: { in: created } } });
    await ctx.close();
  });

  it('requires an owner session', async () => {
    await ctx.api().post('/api/v1/admin/media').expect(401);
    await upload('staff', PNG).expect(403);
    await ctx.staff.get('/admin/media').expect(403);
  });

  it('stores a valid image and serves it safely', async () => {
    const res = await upload('owner', PNG, '../../evil name.png').expect(201);
    created.push(res.body.id);
    expect(res.body).toMatchObject({ altText: 'A photo', mimeType: 'image/png', bytes: PNG.length });
    expect(res.body.url).toMatch(/^\/api\/v1\/uploads\/[a-f0-9]{32}\.png$/); // key is random, never the client's filename
    const file = await ctx.api().get(res.body.url).expect(200);
    expect(file.headers['content-type']).toContain('image/png');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toContain("default-src 'none'");
    expect(Buffer.compare(file.body, PNG)).toBe(0);
  });

  it('rejects anything that is not really a JPEG/PNG/WebP, whatever it is called', async () => {
    await upload('owner', 'just some text', 'fake.png').expect(400);
    await upload('owner', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'x.svg').expect(400);
    await upload('owner', '<script>alert(1)</script>', 'x.png').expect(400);
    await upload('owner', 'GIF89a......', 'x.gif').expect(400);
    await ctx.owner.post('/admin/media').field('altText', 'no file').expect(400);
  });

  it('rejects files over 5 MB', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 10)]);
    await upload('owner', big).expect(413);
  });

  it('will not serve anything outside its own random keys (path traversal)', async () => {
    await ctx.api().get('/api/v1/uploads/..%2f..%2fpackage.json').expect(404);
    await ctx.api().get('/api/v1/uploads/not-a-key').expect(404);
    await ctx.api().get('/api/v1/uploads/%2e%2e%2f.env').expect(404);
  });

  it('edits alt text', async () => {
    const { body } = await upload('owner', PNG).expect(201);
    created.push(body.id);
    const r = await ctx.owner.patch(`/admin/media/${body.id}`).send({ altText: 'Golden dhokla on a plate' }).expect(200);
    expect(r.body.altText).toBe('Golden dhokla on a plate');
    await ctx.owner.patch(`/admin/media/${body.id}`).send({ altText: 'x'.repeat(201) }).expect(400);
    await ctx.owner.patch('/admin/media/nope').send({ altText: 'x' }).expect(404);
  });

  it('replaces the picture but keeps the id, and removes the old file', async () => {
    const first = (await upload('owner', PNG).expect(201)).body;
    created.push(first.id);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
    const replaced = (await ctx.owner.put(`/admin/media/${first.id}/file`).attach('file', jpeg, 'new.jpg').expect(200)).body;
    expect(replaced.id).toBe(first.id);
    expect(replaced.url).not.toBe(first.url);
    expect(replaced.mimeType).toBe('image/jpeg');
    await ctx.api().get(first.url).expect(404); // old file is gone
    await ctx.api().get(replaced.url).expect(200);
    await ctx.owner.put(`/admin/media/${first.id}/file`).attach('file', Buffer.from('nope'), 'x.png').expect(400);
  });

  it('refuses to delete an image that is in use, and deletes unused ones completely', async () => {
    const img = (await upload('owner', PNG).expect(201)).body;
    created.push(img.id);
    const cat = await ctx.prisma.menuCategory.findFirstOrThrow({ where: { isArchived: false } });
    const item = await ctx.prisma.menuItem.create({ data: { categoryId: cat.id, name: 'E2E media item', slug: `e2e-media-${Date.now()}`, priceCents: 100, dietaryLabels: [], imageId: img.id } });

    const blocked = await ctx.owner.delete(`/admin/media/${img.id}`).expect(409);
    expect(blocked.body.message).toContain('1 menu item');
    await ctx.api().get(img.url).expect(200); // untouched

    await ctx.prisma.menuItem.delete({ where: { id: item.id } });
    await ctx.owner.delete(`/admin/media/${img.id}`).expect(204);
    await ctx.api().get(img.url).expect(404);
    expect(await ctx.prisma.mediaAsset.count({ where: { id: img.id } })).toBe(0);
    await ctx.owner.delete(`/admin/media/${img.id}`).expect(404);
  });

  it('will not delete the payment QR image while it is in use', async () => {
    const settings = await ctx.prisma.siteSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(settings.paymentQrId).not.toBeNull();
    const r = await ctx.owner.delete(`/admin/media/${settings.paymentQrId}`).expect(409);
    expect(r.body.message).toContain('payment QR');
  });
});
