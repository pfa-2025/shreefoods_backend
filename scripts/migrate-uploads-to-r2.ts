/**
 * One-off: move images that were uploaded to local disk into Cloudflare R2, and point their database rows at the new
 * address. Safe to re-run: rows that already live in R2 are skipped, and a file is only deleted locally by you, never here.
 *
 *   npx tsx scripts/migrate-uploads-to-r2.ts          (uses DATABASE_URL, UPLOAD_DIR and the R2_* settings from .env)
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
const dir = path.resolve(process.env.UPLOAD_DIR ?? './uploads');
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.mediaAsset.findMany({ where: { url: { startsWith: '/api/v1/uploads/' } } });
  let moved = 0, missing = 0;
  for (const row of rows) {
    const file = row.url.slice('/api/v1/uploads/'.length);
    const ext = path.extname(file).slice(1) as keyof typeof MIME;
    if (!(ext in MIME) || file.includes('/')) { console.log(`skip ${row.id}: unexpected file name ${file}`); continue; }
    let data: Buffer;
    try { data = await readFile(path.join(dir, file)); } catch { console.log(`missing on disk: ${file} (row ${row.id})`); missing++; continue; }
    const stored = await storage.save(data, ext, MIME[ext]);
    await prisma.mediaAsset.update({ where: { id: row.id }, data: { url: stored.url, publicId: stored.key } });
    moved++;
    console.log(`moved ${file} -> ${stored.url}`);
  }
  console.log(`\n${moved} moved, ${missing} missing on disk, ${rows.length - moved - missing} skipped.`);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); }).finally(() => prisma.$disconnect());
