/**
 * Release gate B: list every push/fold solver verdict class for a user and every verified mistake
 * with its exact inputs, so each number in the leak report can be traced to one real hand.
 * Re-derives each verdict from the stored raw hand text and checks it equals the stored one.
 * Usage: DATABASE_URL=<db> npx tsx scripts/audit-pushfold.ts <email>
 */
import { type DecisionRow, analyzeSolver, auditHand, classifySolver, snapshotForHeroAction } from '@pdl/core';
import { prisma } from '../src/db';
import { loadDecisionRows } from '../src/leakEngine';
import { pfAuditFor } from '../src/realhands/import';

const u = await prisma.user.findUniqueOrThrow({ where: { email: process.argv[2]! } });
const rows = await loadDecisionRows(u.id);
const pf = rows.filter((r) => r.pfAudit);
const cls = new Map<string, number>();
for (const r of pf) cls.set(classifySolver(r), (cls.get(classifySolver(r)) ?? 0) + 1);
console.log('push/fold spots', pf.length, Object.fromEntries(cls));
const dup = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT "realHandId" FROM "RealDecision" WHERE "userId" = ${u.id} AND "pfAudit" IS NOT NULL GROUP BY 1 HAVING count(*) > 1) x`;
const dupHands = await prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM (SELECT "handId" FROM "RealHand" WHERE "userId" = ${u.id} GROUP BY 1 HAVING count(*) > 1) x`;
console.log('hands with >1 push/fold verdict:', Number(dup[0]!.n), '| duplicate hand ids:', Number(dupHands[0]!.n));
// re-derive every stored verdict from the raw hand
const recs = await prisma.realDecision.findMany({ where: { userId: u.id, pfAudit: { not: { equals: null } } }, select: { id: true, heroActionNo: true, pfAudit: true, realHand: { select: { raw: true, handId: true, format: true } } } });
let same = 0;
for (const d of recs) {
  const a = auditHand(d.realHand.raw);
  const snap = a.rec ? snapshotForHeroAction(a.rec, d.heroActionNo) : null;
  const again = a.rec && snap ? pfAuditFor(a.rec, snap.actionIndex) : null;
  // jsonb does not keep key order: compare canonically
  const canon = (o: unknown): string => JSON.stringify(o, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
  if (canon(again) === canon(d.pfAudit)) same++;
}
console.log(`re-derived from raw text: ${same}/${recs.length} identical`);
const handOf = new Map(recs.map((d) => [d.id, d.realHand]));
const s = analyzeSolver(rows);
console.log('summary', { graded: s.graded, verified: s.verifiedMistakes, nearThreshold: s.nearThreshold, inconclusiveBounty: s.inconclusive, evLossBB: s.evLossBB });
for (const f of s.findings) console.log(`  ${f.key.padEnd(28)} verified ${String(f.n).padStart(2)} / ${String(f.spots).padStart(3)} spots | sum ${f.evLossBB} BB (conservative ${f.evLossMinBB}) avg ${f.avgEvLossBB} | nearThreshold ${f.nearThreshold} | inconclusive ${f.inconclusive}`);
console.log('\nnot verified (grid rounding could produce the verdict):');
for (const r of pf.filter((x) => classifySolver(x) === 'nearThreshold')) {
  const p = r.pfAudit as NonNullable<DecisionRow['pfAudit']> & { exactStackBB?: number; exactDeadBB?: number; deadBB?: number };
  console.log(`  ${handOf.get(r.id)!.handId.padEnd(14)} ${r.formatGroup?.padEnd(7)} ${p.role.padEnd(7)} ${p.heroClass.padEnd(4)} ${p.heroAction.padEnd(5)} stack ${p.exactStackBB}→${p.stackBB} dead ${p.exactDeadBB}→${p.deadBB} | ${p.grade} loss ${p.evLossBB} (cell ${p.evLossRangeBB?.join('–') ?? 'outside grid'})`);
}
console.log('\nverified mistakes:');
const v = pf.filter((r) => classifySolver(r) === 'verified').sort((a, b) => (b.pfAudit!.evLossBB ?? 0) - (a.pfAudit!.evLossBB ?? 0));
for (const r of v) {
  const p = r.pfAudit as NonNullable<DecisionRow['pfAudit']> & { exactStackBB?: number; exactDeadBB?: number; deadBB?: number };
  console.log(`  ${handOf.get(r.id)!.handId.padEnd(14)} ${r.playedAt?.slice(0, 10)} ${r.formatGroup?.padEnd(7)} ${p.role.padEnd(7)} ${p.heroClass.padEnd(4)} ${p.heroAction.padEnd(5)} stack ${p.exactStackBB}→${p.stackBB} dead ${p.exactDeadBB}→${p.deadBB} | ${p.grade} loss ${p.evLossBB} BB (cell ${p.evLossRangeBB?.join('–')}) best ${p.bestAction}`);
}
await prisma.$disconnect();
