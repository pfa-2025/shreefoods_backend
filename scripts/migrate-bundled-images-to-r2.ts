/**
 * One-off: move the images that ship inside the website (dish photos, the placeholder payment QR) into Cloudflare R2
 * and point their image-library rows at the new address. Safe to re-run: rows already in R2 are skipped.
 *
 *   FRONTEND_PUBLIC_DIR=../frontend/public npx tsx scripts/migrate-bundled-images-to-r2.ts
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { R2Storage } from '../src/media/storage';

const need = (k: string): string => process.env[k] ?? (() => { throw new Error(`Set ${k}`); })();
const storage = new R2Storage({
  endpoint: need('R2_ENDPOINT'), accessKeyId: need('R2_ACCESS_KEY_ID'), secretAccessKey: need('R2_SECRET_ACCESS_KEY'),
  bucket: need('R2_BUCKET'), publicUrl: need('R2_PUBLIC_URL'),
});
const publicDir = path.resolve(process.env.FRONTEND_PUBLIC_DIR ?? '../frontend/public');
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.mediaAsset.findMany({ where: { url: { startsWith: '/images/' } } });
  let moved = 0;
  for (const row of rows) {
    const ext = path.extname(row.url).slice(1).toLowerCase() as keyof typeof MIME;
    const file = path.resolve(publicDir, row.url.slice(1));
    if (!(ext in MIME) || !file.startsWith(publicDir + path.sep)) { console.log(`skip ${row.id}: ${row.url}`); continue; }
    const data = await readFile(file);
    const stored = await storage.save(data, ext, MIME[ext]);
    await prisma.mediaAsset.update({ where: { id: row.id }, data: { url: stored.url, publicId: stored.key, bytes: data.length } });
    moved++;
    console.log(`${row.url} -> ${stored.url}`);
  }
  console.log(`\n${moved} moved, ${rows.length - moved} skipped.`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }).finally(() => prisma.$disconnect());
