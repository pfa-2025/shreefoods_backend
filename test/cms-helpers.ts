import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { LocalStorage, StorageProvider } from '../src/media/storage';
import { PrismaService } from '../src/prisma/prisma.service';
import { setupApp } from '../src/setup-app';

export const ORIGIN = 'http://localhost:3000';
export const PW = 'a-long-test-password-1';
// Smallest valid PNG (1x1)
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export async function boot(prefix: string, configure: (b: TestingModuleBuilder) => TestingModuleBuilder = (b) => b) {
  // Uploads in tests go to a throwaway folder, never the developer's real ./uploads.
  const uploadDir = await mkdtemp(path.join(tmpdir(), 'sf-e2e-uploads-'));
  const app: INestApplication = (await configure(Test.createTestingModule({ imports: [AppModule] }).overrideProvider(StorageProvider).useValue(new LocalStorage(uploadDir))).compile()).createNestApplication();
  setupApp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  const vada = await prisma.menuItem.findUnique({ where: { slug: 'vada-pav' } });
  if (!vada || !vada.isAvailable || vada.isArchived) {
    throw new Error('These tests need "Vada Pav" to exist and be available. It is switched off or missing in your database: mark it available in Admin > Menu (or run `npm run db:seed`), then re-run.');
  }
  const owner = `${prefix}-owner@admin.example`;
  const staff = `${prefix}-staff@admin.example`;
  await prisma.adminUser.deleteMany({ where: { email: { in: [owner, staff] } } });
  const passwordHash = await hashPassword(PW);
  await prisma.adminUser.createMany({ data: [{ email: owner, name: 'Owner', role: 'OWNER', passwordHash }, { email: staff, name: 'Staff', role: 'STAFF', passwordHash }] });

  const api = () => request(app.getHttpServer());
  const csrf = <T extends request.Test>(r: T) => r.set('Origin', ORIGIN).set('X-Requested-With', 'shree-admin');
  const login = async (email: string) => {
    const res = await csrf(api().post('/api/v1/admin/auth/login')).send({ email, password: PW }).expect(200);
    return ((res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('sf_admin=')) ?? '').split(';')[0];
  };
  const [ownerCookie, staffCookie] = [await login(owner), await login(staff)];
  /** Authenticated admin request with the CSRF header. */
  const as = (cookie: string) => ({
    get: (p: string) => api().get(`/api/v1${p}`).set('Cookie', cookie),
    post: (p: string) => csrf(api().post(`/api/v1${p}`)).set('Cookie', cookie),
    put: (p: string) => csrf(api().put(`/api/v1${p}`)).set('Cookie', cookie),
    patch: (p: string) => csrf(api().patch(`/api/v1${p}`)).set('Cookie', cookie),
    delete: (p: string) => csrf(api().delete(`/api/v1${p}`)).set('Cookie', cookie),
  });
  const close = async () => {
    await prisma.adminUser.deleteMany({ where: { email: { in: [owner, staff] } } });
    await app.close();
    await rm(uploadDir, { recursive: true, force: true });
  };
  return { app, prisma, api, csrf, ownerCookie, staffCookie, owner: as(ownerCookie), staff: as(staffCookie), close };
}
