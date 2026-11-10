/**
 * One-off: copy every row from the old Postgres database into the MySQL/MariaDB one the app now uses.
 *
 *   SOURCE_DATABASE_URL=postgresql://user@localhost:5432/shreefoods \
 *   DATABASE_URL=mysql://... npx tsx scripts/migrate-from-postgres.ts
 *
 * Safe to run: it only reads Postgres, and refuses to write into a MySQL database that already holds data.
 * Order numbers and event sequence numbers are kept, and the auto-increment counters continue after them.
 */
import { execFileSync } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';

// Parents before children, so every foreign key already exists when a row is inserted.
const TABLES = [
  'AdminUser', 'AdminSession', 'PasswordResetToken', 'MediaAsset', 'MenuCategory', 'MenuItem',
  'Order', 'OrderItem', 'OrderEvent', 'Announcement', 'Page', 'SiteSettings', 'EmailLog', 'Review',
] as const;

const source = process.env.SOURCE_DATABASE_URL;
if (!source) throw new Error('Set SOURCE_DATABASE_URL to the Postgres connection string');
const prisma = new PrismaClient();

function pg(sql: string): string {
  return execFileSync('psql', [source!, '-At', '-c', sql], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }).trim();
}

type Row = Record<string, unknown>;
const model = (name: string) => Prisma.dmmf.datamodel.models.find((m) => m.name === name)!;
const delegate = (name: string) => (prisma as unknown as Record<string, { count(): Promise<number>; createMany(a: { data: Row[] }): Promise<unknown> }>)[name[0].toLowerCase() + name.slice(1)];

/** Postgres hands back JSON; turn each value into what Prisma expects for its column type. */
function convert(name: string, row: Row): Row {
  const out: Row = {};
  for (const f of model(name).fields) {
    if (f.kind === 'object') continue;
    const v = row[f.name];
    if (v === undefined) continue;
    if (v === null) out[f.name] = f.type === 'Json' ? Prisma.DbNull : null;
    else if (f.type === 'DateTime') out[f.name] = new Date(/[zZ]|[+-]\d\d(:?\d\d)?$/.test(String(v)) ? String(v) : `${v}Z`); // timestamps were stored as UTC
    else if (f.type === 'BigInt') out[f.name] = BigInt(v as string | number);
    else out[f.name] = v;
  }
  return out;
}

async function main() {
  // Never mix data: the target must be brand new.
  for (const t of TABLES) {
    const n = await delegate(t).count();
    if (n > 0) throw new Error(`Target table ${t} already has ${n} rows. Refusing to copy into a database that holds data.`);
  }

  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = JSON.parse(pg(`select coalesce(json_agg(t), '[]'::json) from (select * from "${t}") t`)) as Row[];
    counts[t] = rows.length;
    for (let i = 0; i < rows.length; i += 200) {
      await delegate(t).createMany({ data: rows.slice(i, i + 200).map((r) => convert(t, r)) });
    }
    console.log(`${t.padEnd(20)} ${rows.length}`);
  }

  // Continue the counters after the highest value Postgres ever handed out (gaps from deleted rows included).
  for (const [table, column, seq] of [['Order', 'orderNumber', 'Order_orderNumber_seq'], ['OrderEvent', 'seq', 'OrderEvent_seq_seq']] as const) {
    const [last, called] = pg(`select last_value, is_called from "${seq}"`).split('|');
    const next = called === 't' ? Number(last) + 1 : Number(last);
    await prisma.$executeRawUnsafe(`ALTER TABLE \`${table}\` AUTO_INCREMENT = ${next}`);
    console.log(`${table}.${column} continues from ${next}`);
  }

  // Verify: every table has the same row count, and the money adds up.
  for (const t of TABLES) {
    const n = await delegate(t).count();
    if (n !== counts[t]) throw new Error(`Row count mismatch in ${t}: Postgres ${counts[t]}, MySQL ${n}`);
  }
  const [a] = await prisma.$queryRaw<{ n: bigint; total: bigint | null }[]>`SELECT COUNT(*) AS n, SUM(totalCents) AS total FROM \`Order\``;
  const b = pg('select count(*), coalesce(sum("totalCents"),0) from "Order"').split('|');
  if (Number(a.n) !== Number(b[0]) || Number(a.total ?? 0) !== Number(b[1])) throw new Error('Order totals differ between the two databases');
  console.log(`\nVerified: ${TABLES.length} tables match; ${a.n} orders totalling ${Number(a.total ?? 0) / 100} dollars.`);
}

main()
  .catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
