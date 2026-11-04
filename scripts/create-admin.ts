/**
 * Create (or reset) an admin account.
 *   ADMIN_PASSWORD='...' npm run admin:create -- owner@example.com "Owner Name" OWNER
 * Without ADMIN_PASSWORD a random one is generated and printed once.
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { MIN_PASSWORD_LENGTH, hashPassword } from '../src/auth/password';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const [email, name = 'Admin', roleArg = 'STAFF'] = process.argv.slice(2);
  if (!email || !email.includes('@')) throw new Error('Usage: npm run admin:create -- <email> "<name>" <OWNER|STAFF>');
  if (roleArg !== 'OWNER' && roleArg !== 'STAFF') throw new Error('Role must be OWNER or STAFF');

  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD ?? randomBytes(15).toString('base64url');
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);

  const passwordHash = await hashPassword(password);
  const admin = await prisma.adminUser.upsert({
    where: { email: email.toLowerCase() },
    update: { passwordHash, name, role: roleArg, isActive: true },
    create: { email: email.toLowerCase(), name, role: roleArg, passwordHash },
  });
  await prisma.adminSession.deleteMany({ where: { adminId: admin.id } });
  console.log(`${roleArg} account ready: ${admin.email}`);
  if (generated) console.log(`Generated password (shown once): ${password}`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
