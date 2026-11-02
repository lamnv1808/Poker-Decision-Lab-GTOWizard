import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { ownerEmails } from './env';
import { tablesInOrder } from './backup';
import { integrityReport } from './integrity';

/**
 * Removal of generated test accounts (@test.dev only). Shared by the admin endpoint and
 * scripts/test-accounts.ts. Two steps: a dry run returns a manifest (every row that would be deleted,
 * per table) and its canonical hash; the deletion must send that hash back. The deletion recomputes the
 * manifest INSIDE its own SERIALIZABLE transaction and aborts (rolls back everything) on any difference,
 * on any row count that does not match the manifest, or on any reference from other users' data.
 */
type Db = typeof prisma | Prisma.TransactionClient;
export const TEST_DOMAIN = '@test.dev';

/**
 * Canonical JSON (manifest hash algorithm "pdl-manifest-v2"): object keys sorted by code point at every
 * level, arrays kept in order, no whitespace, UTF-8. The hash is SHA-256 of that text, so it does not
 * depend on the order in which Postgres lists foreign keys (which differs between a database built by
 * `prisma migrate deploy` and one restored with `pg_restore`).
 */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export const MANIFEST_HASH_ALGORITHM = 'pdl-manifest-v2 (sha256 of canonical JSON: keys sorted, accounts sorted by id)';
export const manifestHash = (manifest: object) => createHash('sha256').update(canonicalJson(manifest)).digest('hex');

export interface DeletionManifest {
  accounts: { id: string; email: string; createdAt: string }[];
  rows: Record<string, number>;
  /** Rows without a userId column that Postgres removes by ON DELETE CASCADE from the rows above. */
  cascade: Record<string, number>;
  external: Record<string, number>;
}

const n = async (db: Db, sql: string, ...params: unknown[]) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(sql, ...params))[0]!.n);

export async function deletionManifest(ids: string[], db: Db = prisma) {
  const users = await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, createdAt: true } });
  const problems: string[] = [];
  for (const id of ids) {
    const u = users.find((x) => x.id === id);
    if (!u) problems.push(`${id}: not found`);
    else if (!u.email.toLowerCase().endsWith(TEST_DOMAIN)) problems.push(`${id}: not a ${TEST_DOMAIN} account`);
    else if (ownerEmails.has(u.email.toLowerCase())) problems.push(`${id}: owner account`);
  }
  const userIdTables = new Set(
    (await db.$queryRaw<{ t: string }[]>`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'userId'`).map((r) => r.t),
  );
  // every FK column that points at User: rows owned by these accounts, and rows of OTHER users that refer to them
  const fks = await db.$queryRaw<{ tbl: string; col: string }[]>`
    SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = '"User"'::regclass
    ORDER BY 1, 2`;
  const rows: Record<string, number> = {};
  const external: Record<string, number> = {};
  for (const f of fks) {
    const t = f.tbl.replace(/^"|"$/g, '');
    if (f.col === 'userId') rows[t] = await n(db, `SELECT count(*) AS n FROM "${t}" WHERE "userId" = ANY($1::text[])`, ids);
    else {
      const k = await n(db, userIdTables.has(t) ? `SELECT count(*) AS n FROM "${t}" WHERE "${f.col}" = ANY($1::text[]) AND NOT ("userId" = ANY($1::text[]))` : `SELECT count(*) AS n FROM "${t}" WHERE "${f.col}" = ANY($1::text[])`, ids);
      if (k) external[`${t}.${f.col}`] = k;
    }
  }
  // indirect cross-user references: another user's row pointing at a row owned by these accounts
  const indirect = await db.$queryRaw<{ child: string; ccol: string; parent: string; pcol: string }[]>`
    SELECT c.conrelid::regclass::text AS child, ca.attname AS ccol, c.confrelid::regclass::text AS parent, pa.attname AS pcol
    FROM pg_constraint c
    JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND c.confrelid <> '"User"'::regclass AND cardinality(c.conkey) = 1
    ORDER BY 1, 2`;
  const cascade: Record<string, number> = {};
  for (const f of indirect) {
    const child = f.child.replace(/^"|"$/g, '');
    const parent = f.parent.replace(/^"|"$/g, '');
    if (!userIdTables.has(parent)) continue;
    if (!userIdTables.has(child)) {
      cascade[child] = (cascade[child] ?? 0) + (await n(db, `SELECT count(*) AS n FROM "${child}" c JOIN "${parent}" p ON p."${f.pcol}" = c."${f.ccol}" WHERE p."userId" = ANY($1::text[])`, ids));
      continue;
    }
    const k = await n(db, `SELECT count(*) AS n FROM "${child}" c JOIN "${parent}" p ON p."${f.pcol}" = c."${f.ccol}" WHERE p."userId" = ANY($1::text[]) AND NOT (c."userId" = ANY($1::text[]))`, ids);
    if (k) external[`${child}.${f.ccol}->${parent}`] = k;
  }
  if (Object.keys(external).length) problems.push(`referenced by other users' data: ${JSON.stringify(external)}`);
  const manifest: DeletionManifest = { accounts: users.map((u) => ({ id: u.id, email: u.email, createdAt: u.createdAt.toISOString() })).sort((a, b) => a.id.localeCompare(b.id)), rows, cascade, external };
  return { manifest, hash: manifestHash(manifest), hashAlgorithm: MANIFEST_HASH_ALGORITHM, problems };
}

/** Dry run in a READ ONLY transaction: cannot change anything, whatever the code below it does. */
export async function dryRunTestAccounts(ids: string[]) {
  const sorted = [...new Set(ids)].sort();
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      return deletionManifest(sorted, tx);
    },
    { isolationLevel: 'RepeatableRead', timeout: 120_000 },
  );
}

export class DeletionAborted extends Error {
  constructor(message: string, readonly detail: object) {
    super(message);
  }
}

/**
 * Delete exactly the confirmed manifest. Everything happens in ONE serializable transaction:
 * recompute the manifest → must hash to confirmHash and have no problems → delete children first →
 * every per-table count must equal the manifest → delete the accounts (must be exactly ids.length).
 * Any mismatch throws and Postgres rolls the whole transaction back.
 */
export async function deleteTestAccounts(ids: string[], confirmHash: string) {
  const sorted = [...new Set(ids)].sort();
  const before = await integrityReport();
  const result = await prisma.$transaction(
    async (tx) => {
      const m = await deletionManifest(sorted, tx);
      if (m.problems.length) throw new DeletionAborted('problems', m);
      if (m.hash !== confirmHash) throw new DeletionAborted('manifest_changed', m);
      const deleted: Record<string, number> = {};
      const cascadeBefore: Record<string, number> = {};
      for (const t of Object.keys(m.manifest.cascade)) cascadeBefore[t] = await n(tx, `SELECT count(*) AS n FROM "${t}"`);
      const order = (await tablesInOrder(tx)).reverse();
      for (const t of order) {
        if (t === 'User' || m.manifest.rows[t] === undefined) continue;
        deleted[t] = await tx.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "userId" = ANY($1::text[])`, sorted);
      }
      const mismatch = Object.keys(m.manifest.rows).filter((t) => (deleted[t] ?? 0) !== m.manifest.rows[t]);
      if (mismatch.length) throw new DeletionAborted('row_count_mismatch', { mismatch, deleted, expected: m.manifest.rows });
      const users = await tx.$executeRawUnsafe(`DELETE FROM "User" WHERE id = ANY($1::text[]) AND lower(email) LIKE $2`, sorted, `%${TEST_DOMAIN}`);
      if (users !== sorted.length) throw new DeletionAborted('account_count_mismatch', { expected: sorted.length, users });
      for (const t of Object.keys(m.manifest.cascade)) {
        const gone = cascadeBefore[t]! - (await n(tx, `SELECT count(*) AS n FROM "${t}"`));
        if (gone !== m.manifest.cascade[t]) throw new DeletionAborted('cascade_count_mismatch', { table: t, expected: m.manifest.cascade[t], gone });
        deleted[t] = gone;
      }
      return { ...m, deletedRows: { ...deleted, User: users } };
    },
    { isolationLevel: 'Serializable', timeout: 120_000 },
  );
  const after = await integrityReport();
  const remainingSessions = await prisma.session.count({ where: { userId: { in: sorted } } });
  return { deleted: true as const, ...result, remainingSessions, before: { counts: before.counts, fingerprints: before.fingerprints }, after: { ok: after.ok, failed: after.failed, counts: after.counts, fingerprints: after.fingerprints, users: after.users } };
}
