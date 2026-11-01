import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import type { Response } from 'express';
import { prisma } from './db';

/**
 * Logical backup of the whole database, streamed as gzip NDJSON (read-only, admin-only).
 * Needed because the free Postgres plan offers no backups or exports. Format:
 *   {"v":1,"kind":"header","createdAt":...,"tables":[...dependency order...]}
 *   {"t":"<Table>","r":{...row as Postgres row_to_json...}}          (one line per row)
 *   {"kind":"manifest","tables":{"<Table>":{"rows":n,"md5":"..."}}}  (computed by Postgres)
 * Restore with scripts/restore-backup.ts, which re-verifies every table's count and checksum.
 */
export const BACKUP_VERSION = 1;
const EXCLUDE = new Set(['_prisma_migrations']); // the target is migrated by `prisma migrate deploy`

/** Tables in foreign-key dependency order (parents before children). */
export async function tablesInOrder(db = prisma): Promise<string[]> {
  const tables = (await db.$queryRaw<{ t: string }[]>`SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`).map((x) => x.t).filter((t) => !EXCLUDE.has(t));
  const fks = await db.$queryRaw<{ child: string; parent: string }[]>`SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`;
  const strip = (x: string) => x.replace(/^"|"$/g, '');
  const deps = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const f of fks) if (strip(f.child) !== strip(f.parent)) deps.get(strip(f.child))?.add(strip(f.parent));
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string, path: Set<string>) => {
    if (seen.has(t)) return;
    if (path.has(t)) throw new Error(`FK cycle at ${t}`);
    path.add(t);
    for (const p of deps.get(t) ?? []) visit(p, path);
    path.delete(t);
    seen.add(t);
    out.push(t);
  };
  for (const t of [...tables].sort()) visit(t, new Set());
  return out;
}

/** Row count and an order-independent checksum of a table, computed inside Postgres. */
export async function tableChecksum(table: string, db = prisma): Promise<{ rows: number; md5: string }> {
  const r = await db.$queryRawUnsafe<{ n: bigint; h: string | null }[]>(
    `SELECT count(*) AS n, md5(coalesce(string_agg(x.h, '' ORDER BY x.h), '')) AS h FROM (SELECT md5(row_to_json(t)::text) AS h FROM "${table}" t) x`,
  );
  return { rows: Number(r[0]!.n), md5: r[0]!.h ?? '' };
}

const hasId = async (table: string) =>
  (await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'id'`)[0]!.n > 0n;

/** Stream the backup to an HTTP response. Rows are read in id-ordered pages to keep memory flat. */
export async function streamBackup(res: Response) {
  const tables = await tablesInOrder();
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="pdl-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.ndjson.gz"`);
  const gz = createGzip({ level: 6 });
  gz.pipe(res);
  const write = (o: unknown) => new Promise<void>((ok) => (gz.write(`${JSON.stringify(o)}\n`) ? ok() : gz.once('drain', ok)));
  const stream = createHash('sha256');
  await write({ v: BACKUP_VERSION, kind: 'header', createdAt: new Date().toISOString(), tables });
  const manifest: Record<string, { rows: number; md5: string }> = {};
  for (const t of tables) {
    let written = 0;
    if (await hasId(t)) {
      let last = '';
      for (;;) {
        const page = await prisma.$queryRawUnsafe<{ id: string; j: unknown }[]>(`SELECT t.id::text AS id, row_to_json(t) AS j FROM "${t}" t WHERE t.id::text > $1 ORDER BY t.id::text LIMIT 1000`, last);
        if (!page.length) break;
        for (const p of page) {
          await write({ t, r: p.j });
          written++;
        }
        last = page[page.length - 1]!.id;
      }
    } else {
      const rows = await prisma.$queryRawUnsafe<{ j: unknown }[]>(`SELECT row_to_json(t) AS j FROM "${t}" t`);
      for (const p of rows) await write({ t, r: p.j });
      written = rows.length;
    }
    // checksum computed by Postgres over exactly the rows that exist now
    manifest[t] = await tableChecksum(t);
    if (manifest[t].rows !== written) manifest[t] = { ...manifest[t], rows: -1 }; // changed during backup: flag it
    stream.update(`${t}:${manifest[t].rows}:${manifest[t].md5};`);
  }
  await write({ kind: 'manifest', tables: manifest, digest: stream.digest('hex') });
  gz.end();
}
