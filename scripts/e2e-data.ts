/**
 * Test-data helper for the Playwright suite.
 *   npm run e2e:data -- prepare   create the throwaway admin accounts and make sure ordering is switched on
 *   npm run e2e:data -- cleanup   delete them and any orders made by browser tests
 */
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password';
import { R2Storage } from '../src/media/storage';
import { assertLocalDatabase } from './local-only';

const prisma = new PrismaClient();
const ACCOUNTS = [
  { email: 'e2e-owner@admin.example', name: 'E2E Owner', role: 'OWNER' as const, password: 'e2e-owner-password-1' },
  { email: 'e2e-staff@admin.example', name: 'E2E Staff', role: 'STAFF' as const, password: 'e2e-staff-password-1' },
];

async function main(): Promise<void> {
  assertLocalDatabase(process.env.DATABASE_URL, 'The browser-test helper');
  const mode = process.argv[2];
  if (mode === 'prepare') {
    for (const a of ACCOUNTS) {
      const passwordHash = await hashPassword(a.password);
      await prisma.adminUser.upsert({
        where: { email: a.email },
        update: { passwordHash, isActive: true },
        create: { email: a.email, name: a.name, role: a.role, passwordHash },
      });
    }
    // The cart tests need the Add buttons, so menu-only mode must be off while they run.
    await prisma.siteSettings.updateMany({ where: { id: 'singleton' }, data: { cartEnabled: true } });
    console.log('e2e accounts ready (cart and ordering switched on)');
  } else if (mode === 'seed-old-order') {
    // An order placed 45 days ago, so tests can prove the dashboard's "All time" view and the Excel export reach back that far.
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { slug: 'vada-pav' } });
    const placed = new Date(Date.now() - 45 * 86_400_000);
    const order = await prisma.order.create({
      data: {
        publicToken: randomBytes(24).toString('base64url'), customerName: 'Old Order Check', customerEmail: 'e2e-old@orders.example', customerPhone: '+15550102030',
        fulfillmentType: 'PICKUP', subtotalCents: item.priceCents, taxCents: 58, totalCents: item.priceCents + 58, paymentStatus: 'PAID', paymentVerifiedAt: placed, fulfillmentStatus: 'COMPLETED',
        createdAt: placed, items: { create: [{ menuItemId: item.id, nameSnapshot: item.name, unitPriceCents: item.priceCents, quantity: 1, lineTotalCents: item.priceCents }] },
      },
    });
    console.log(`ORDER_NUMBER=${order.orderNumber}`);
  } else if (mode === 'cleanup') {
    await prisma.emailLog.deleteMany({ where: { toEmail: { endsWith: '.example' } } });
    const orders = await prisma.order.deleteMany({ where: { customerEmail: { endsWith: '.example' } } });
    const admins = await prisma.adminUser.deleteMany({ where: { email: { startsWith: 'e2e-' } } });
    // Content created by CMS browser tests (prefixed "E2E ")
    await prisma.announcement.deleteMany({ where: { title: { startsWith: 'E2E ' } } });
    await prisma.menuItem.deleteMany({ where: { name: { startsWith: 'E2E ' } } });
    await prisma.menuCategory.deleteMany({ where: { name: { startsWith: 'E2E ' } } });
    // Images uploaded by CMS browser tests (alt text starts with "E2E "), including their files (local disk or Cloudflare R2)
    const media = await prisma.mediaAsset.findMany({ where: { altText: { startsWith: 'E2E ' } } });
    const r2 = process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET && process.env.R2_PUBLIC_URL
      ? new R2Storage({ endpoint: process.env.R2_ENDPOINT, accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET, publicUrl: process.env.R2_PUBLIC_URL })
      : null;
    for (const m of media) {
      if (!m.publicId) continue;
      if (/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(m.publicId)) await rm(path.resolve(process.env.UPLOAD_DIR ?? './uploads', m.publicId), { force: true });
      else if (r2) await r2.remove(m.publicId); // ignores anything that isn't one of its own keys
    }
    await prisma.mediaAsset.deleteMany({ where: { id: { in: media.map((m) => m.id) } } });
    console.log(`removed ${orders.count} test orders, ${admins.count} test admins, ${media.length} test images`);
  } else {
    throw new Error('Usage: e2e-data.ts prepare|seed-old-order|cleanup');
  }
}
main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
