import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/setup-app';

describe('GET /menu (e2e, requires seeded db)', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    setupApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('returns categories with items, integer cent prices and image URLs', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/menu').expect(200);
    const names = res.body.categories.map((c: { name: string }) => c.name);
    expect(names).toEqual(['Appetizers', 'Main Course', 'Drinks', 'Sweets']);
    for (const c of res.body.categories) {
      for (const i of c.items) {
        expect(Number.isInteger(i.priceCents)).toBe(true);
        expect(i.imageUrl).toMatch(/^\/images\/menu\/.+\.jpg$/);
      }
    }
  });
});
