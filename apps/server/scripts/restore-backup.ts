/**
 * Restore (or just verify) a backup produced by GET /api/admin/backup.
 *   DATABASE_URL=<target> npx tsx scripts/restore-backup.ts <backup.ndjson.gz> [--verify-only]
 * The target must already be migrated (`npx prisma migrate deploy`) and EMPTY — the script refuses
 * to write into a database that has data. After loading, every table's row count and checksum are
 * recomputed by Postgres and compared with the backup's manifest; any mismatch exits non-zero.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { prisma } from '../src/db';
import { tableChecksum } from '../src/backup';

const [file, flag] = process.argv.slice(2);
if (!file) throw new Error('usage: restore-backup.ts <backup.ndjson.gz> [--verify-only]');
const verifyOnly = flag === '--verify-only';

async function main() {
  // all-or-nothing: a failed restore leaves the target empty instead of half-filled
  await prisma.$transaction(async (tx) => load(tx), { timeout: 60 * 60 * 1000, maxWait: 30_000 });
  await verify();
}

let header: { tables: string[] } | null = null;
let manifest: { tables: Record<string, { rows: number; md5: string }>; digest: string } | null = null;
const counts: Record<string, number> = {};

async function load(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) {
  const rl = createInterface({ input: createReadStream(file!).pipe(createGunzip()), crlfDelay: Infinity });
  let batch: unknown[] = [];
  let batchTable = '';
  const flush = async () => {
    if (!batch.length) return;
    if (!verifyOnly) await tx.$executeRawUnsafe(`INSERT INTO "${batchTable}" SELECT * FROM json_populate_recordset(null::"${batchTable}", $1::json)`, JSON.stringify(batch));
    batch = [];
  };
  for await (const line of rl) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (o.kind === 'header') {
      header = o;
      if (!verifyOnly) {
        for (const t of o.tables as string[]) {
          const n = Number((await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}"`))[0]!.n);
          if (n > 0) throw new Error(`Target table ${t} is not empty (${n} rows) — refusing to restore into a database with data`);
        }
      }
      continue;
    }
    if (o.kind === 'manifest') {
      manifest = o;
      continue;
    }
    if (o.t !== batchTable || batch.length >= 500) await flush();
    batchTable = o.t;
    batch.push(o.r);
    counts[o.t] = (counts[o.t] ?? 0) + 1;
  }
  await flush();
  if (!header || !manifest) throw new Error('Backup is incomplete (missing header or manifest) — it was cut off');
}

async function verify() {
  if (!header || !manifest) throw new Error('Backup is incomplete');
  let bad = 0;
  for (const t of header.tables) {
    const want = manifest.tables[t]!;
    const fileRows = counts[t] ?? 0;
    const got = verifyOnly ? null : await tableChecksum(t);
    const ok = want.rows === fileRows && (verifyOnly || (got!.rows === want.rows && got!.md5 === want.md5));
    if (!ok) bad++;
    console.log(`${ok ? 'OK ' : 'BAD'} ${t.padEnd(18)} rows file=${fileRows} manifest=${want.rows}${got ? ` restored=${got.rows} md5=${got.md5 === want.md5 ? 'match' : 'MISMATCH'}` : ''}`);
  }
  console.log(bad ? `FAILED: ${bad} table(s) do not match` : `VERIFIED: ${header.tables.length} tables, digest ${manifest.digest.slice(0, 16)}…`);
  await prisma.$disconnect();
  process.exit(bad ? 1 : 0);
}
void main();
