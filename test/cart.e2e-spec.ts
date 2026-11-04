import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { setupApp } from '../src/setup-app';

describe('POST /cart/quote (e2e, requires seeded db)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let vadaPav: { id: string; priceCents: number };

  const quote = (items: unknown) =>
    request(app.getHttpServer()).post('/api/v1/cart/quote').send({ items });

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    vadaPav = await prisma.menuItem.findUniqueOrThrow({ where: { slug: 'vada-pav' } });
  });

  afterAll(async () => {
    await prisma.menuItem.update({ where: { id: vadaPav.id }, data: { isAvailable: true } });
    await app.close();
  });

  it('prices from the database and computes tax server-side', async () => {
    const res = await quote([{ menuItemId: vadaPav.id, quantity: 3 }]).expect(200);
    const settings = await prisma.siteSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(res.body.subtotalCents).toBe(vadaPav.priceCents * 3);
    expect(res.body.taxCents).toBe(Math.floor((vadaPav.priceCents * 3 * settings.taxRateBps + 5000) / 10000));
    expect(res.body.totalCents).toBe(res.body.subtotalCents + res.body.taxCents);
    expect(res.body.canCheckout).toBe(true);
  });

  it('ignores a client-supplied price (tamper attempt)', async () => {
    const res = await quote([{ menuItemId: vadaPav.id, quantity: 1, priceCents: 1, unitPriceCents: 1 }]).expect(200);
    expect(res.body.lines[0].unitPriceCents).toBe(vadaPav.priceCents);
    expect(res.body.subtotalCents).toBe(vadaPav.priceCents);
  });

  it('merges duplicate lines and caps the quantity', async () => {
    const res = await quote([
      { menuItemId: vadaPav.id, quantity: 20 },
      { menuItemId: vadaPav.id, quantity: 20 },
    ]).expect(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].quantity).toBe(20);
  });

  it('excludes unavailable items and blocks checkout', async () => {
    await prisma.menuItem.update({ where: { id: vadaPav.id }, data: { isAvailable: false } });
    const res = await quote([{ menuItemId: vadaPav.id, quantity: 1 }]).expect(200);
    expect(res.body.lines).toHaveLength(0);
    expect(res.body.issues).toEqual([{ menuItemId: vadaPav.id, code: 'UNAVAILABLE', name: 'Vada Pav' }]);
    expect(res.body.subtotalCents).toBe(0);
    expect(res.body.canCheckout).toBe(false);
    await prisma.menuItem.update({ where: { id: vadaPav.id }, data: { isAvailable: true } });
  });

  it('reports unknown items', async () => {
    const res = await quote([{ menuItemId: 'does-not-exist', quantity: 1 }]).expect(200);
    expect(res.body.issues[0].code).toBe('NOT_FOUND');
    expect(res.body.canCheckout).toBe(false);
  });

  it('rejects invalid quantities and malformed bodies with 400', async () => {
    await quote([{ menuItemId: vadaPav.id, quantity: 0 }]).expect(400);
    await quote([{ menuItemId: vadaPav.id, quantity: 21 }]).expect(400);
    await quote([{ menuItemId: vadaPav.id, quantity: 1.5 }]).expect(400);
    await request(app.getHttpServer()).post('/api/v1/cart/quote').send({}).expect(400);
  });
});
