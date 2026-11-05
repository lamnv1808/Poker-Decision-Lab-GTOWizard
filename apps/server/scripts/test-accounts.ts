/**
 * Test-account removal for operators (used by the private pdl-backup workflow `qa-accounts.yml`).
 *
 *   tsx scripts/test-accounts.ts                       # DRY RUN (READ ONLY transaction) — default
 *   tsx scripts/test-accounts.ts --delete --confirm <manifest hash>
 *
 * Ids come from docs/release/test-account-deletion-manifest.json. The deletion recomputes the manifest
 * inside one SERIALIZABLE transaction and rolls back on any difference (see src/accountCleanup.ts).
 * Output is JSON on stdout; it never prints connection strings. Exit code 0 = ok, 2 = refused.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeletionAborted, deleteTestAccounts, dryRunTestAccounts, TEST_DOMAIN } from '../src/accountCleanup';
import { prisma } from '../src/db';

const args = process.argv.slice(2);
const del = args.includes('--delete');
const confirm = args[args.indexOf('--confirm') + 1];
const file = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/release/test-account-deletion-manifest.json');
const ids: string[] = (JSON.parse(readFileSync(file, 'utf8')).accounts as { id: string }[]).map((a) => a.id);

async function realData() {
  const nonTest = await prisma.user.count({ where: { NOT: { email: { endsWith: TEST_DOMAIN, mode: 'insensitive' } } } });
  const [realHands, realDecisions, annotations] = await Promise.all([prisma.realHand.count(), prisma.realDecision.count(), prisma.annotation.count()]);
  // every remaining (non-test) account with its own history: must be identical before and after
  const kept = await prisma.user.findMany({
    where: { NOT: { email: { endsWith: TEST_DOMAIN, mode: 'insensitive' } } },
    select: { id: true, _count: { select: { realHands: true, realDecisions: true, attempts: true, sessions: true } } },
    orderBy: { id: 'asc' },
  });
  return { nonTestAccounts: nonTest, realHands, realDecisions, annotations, keptAccounts: kept.map((u) => ({ id: u.id, ...u._count })) };
}

async function main() {
  const before = await realData();
  if (!del) {
    const r = await dryRunTestAccounts(ids);
    console.log(JSON.stringify({ mode: 'dry-run (READ ONLY transaction, nothing deleted)', ids: ids.length, problems: r.problems, hash: r.hash, hashAlgorithm: r.hashAlgorithm, manifest: r.manifest, realData: before }, null, 1));
    process.exit(r.problems.length ? 2 : 0);
  }
  if (!confirm || !/^[0-9a-f]{64}$/.test(confirm)) throw new Error('--delete needs --confirm <64-hex manifest hash>');
  try {
    const r = await deleteTestAccounts(ids, confirm);
    const after = await realData();
    const unchanged = JSON.stringify(before) === JSON.stringify(after);
    // history fingerprints (real hands, real decisions, annotations) must not move; users/attempts change by design
    const keys = ['realHandRaw', 'realDecisionCore', 'annotations'] as const;
    const fpSame = keys.every((k) => r.before.fingerprints[k] === r.after.fingerprints[k]);
    console.log(JSON.stringify({ mode: 'DELETED', hash: r.hash, deletedRows: r.deletedRows, remainingSessions: r.remainingSessions, integrityOk: r.after.ok, failed: r.after.failed, historyFingerprintsUnchanged: fpSame, realDataBefore: before, realDataAfter: after, realDataUnchanged: unchanged }, null, 1));
    process.exit(r.after.ok && unchanged && fpSame && r.remainingSessions === 0 ? 0 : 1);
  } catch (e) {
    if (e instanceof DeletionAborted) {
      console.log(JSON.stringify({ mode: 'REFUSED — transaction rolled back, nothing deleted', reason: e.message, detail: e.detail }, null, 1));
      process.exit(2);
    }
    throw e;
  }
}

main().finally(() => prisma.$disconnect());
