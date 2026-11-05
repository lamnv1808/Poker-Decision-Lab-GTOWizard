/**
 * Research — Training Scenario Gradeability baseline. READ-ONLY, aggregates only (no ids, users or cards).
 *   DATABASE_URL=<isolated copy> npx tsx scripts/dqe-training-gradeability.ts
 * Groups every training attempt by attempt type, mode, graded flag and grading basis, so the share of training
 * decisions graded by verified solver EV can be compared with model / rubric / ungraded ones.
 */
import { prisma } from '../src/db';

async function main() {
  const rows = await prisma.decisionAttempt.groupBy({ by: ['attemptType', 'mode', 'graded', 'gradeBasis'], _count: { _all: true } });
  const total = rows.reduce((a, r) => a + r._count._all, 0);
  const byBasis: Record<string, number> = {};
  for (const r of rows) byBasis[String(r.gradeBasis ?? 'none')] = (byBasis[String(r.gradeBasis ?? 'none')] ?? 0) + r._count._all;
  const sims = await prisma.simHand.groupBy({ by: ['kind', 'status'], _count: { _all: true } });
  console.log(JSON.stringify({
    version: 'dqe-training-gradeability-1',
    attempts: total,
    byBasis,
    detail: rows.map((r) => ({ type: r.attemptType, mode: r.mode, graded: r.graded, basis: r.gradeBasis ?? 'none', n: r._count._all })).sort((a, b) => b.n - a.n),
    simHands: sims.map((s) => ({ kind: s.kind, status: s.status, n: s._count._all })),
  }));
}
main().finally(() => prisma.$disconnect());
