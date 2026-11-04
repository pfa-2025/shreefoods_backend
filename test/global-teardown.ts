import { PrismaClient } from '@prisma/client';

/** Test orders trigger emails to *.example addresses; deleting an order keeps its email log, so clear them here. */
export default async function globalTeardown(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await prisma.emailLog.deleteMany({ where: { toEmail: { endsWith: '.example' } } });
  } finally {
    await prisma.$disconnect();
  }
}
