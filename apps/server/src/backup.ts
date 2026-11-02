import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import type { Response } from 'express';
import type { Prisma } from '@prisma/client';
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
export async function tablesInOrder(db: Db = prisma): Promise<string[]> {
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
export async function tableChecksum(table: string, db: Db = prisma): Promise<{ rows: number; md5: string }> {
  const r = await db.$queryRawUnsafe<{ n: bigint; h: string | null }[]>(
    `SELECT count(*) AS n, md5(coalesce(string_agg(x.h, '' ORDER BY x.h), '')) AS h FROM (SELECT md5(row_to_json(t)::text) AS h FROM "${table}" t) x`,
  );
  return { rows: Number(r[0]!.n), md5: r[0]!.h ?? '' };
}

type Db = Prisma.TransactionClient | typeof prisma;
const hasId = async (table: string, db: Db) =>
  (await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} AND column_name = 'id'`)[0]!.n > 0n;

/**
 * Stream the backup to an HTTP response. Everything — every table and every checksum — is read in
 * ONE read-only REPEATABLE READ transaction, so the backup is a consistent snapshot even while
 * people keep training (the first production backup proved this is necessary). Rows are read in
 * id-ordered pages to keep memory flat.
 */
export async function streamBackup(res: Response, hooks: { afterTable?: (t: string) => Promise<void> } = {}) {
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="pdl-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.ndjson.gz"`);
  const gz = createGzip({ level: 6 });
  gz.pipe(res);
  const write = (o: unknown) => new Promise<void>((ok) => (gz.write(`${JSON.stringify(o)}\n`) ? ok() : gz.once('drain', ok)));
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const tables = await tablesInOrder(tx);
      const stream = createHash('sha256');
      // schema version: the applied migrations; a restore target must have exactly these
      const migrations = (await tx.$queryRawUnsafe<{ m: string }[]>(`SELECT migration_name AS m FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name`)).map((x) => x.m);
      await write({ v: BACKUP_VERSION, kind: 'header', createdAt: new Date().toISOString(), tables, migrations, snapshot: 'repeatable-read' });
      const manifest: Record<string, { rows: number; md5: string }> = {};
      for (const t of tables) {
        let written = 0;
        if (await hasId(t, tx)) {
          let last = '';
          for (;;) {
            const page = await tx.$queryRawUnsafe<{ id: string; j: unknown }[]>(`SELECT t.id::text AS id, row_to_json(t) AS j FROM "${t}" t WHERE t.id::text > $1 ORDER BY t.id::text LIMIT 1000`, last);
            if (!page.length) break;
            for (const p of page) {
              await write({ t, r: p.j });
              written++;
            }
            last = page[page.length - 1]!.id;
          }
        } else {
          const rows = await tx.$queryRawUnsafe<{ j: unknown }[]>(`SELECT row_to_json(t) AS j FROM "${t}" t`);
          for (const p of rows) await write({ t, r: p.j });
          written = rows.length;
        }
        // same snapshot: the checksum describes exactly the rows written above
        manifest[t] = await tableChecksum(t, tx);
        if (manifest[t].rows !== written) throw new Error(`Snapshot violated for ${t}: wrote ${written}, counted ${manifest[t].rows}`);
        stream.update(`${t}:${manifest[t].rows}:${manifest[t].md5};`);
        await hooks.afterTable?.(t);
      }
      await write({ kind: 'manifest', tables: manifest, digest: stream.digest('hex') });
    },
    { isolationLevel: 'RepeatableRead', timeout: 60 * 60 * 1000, maxWait: 30_000 },
  );
  gz.end();
}
