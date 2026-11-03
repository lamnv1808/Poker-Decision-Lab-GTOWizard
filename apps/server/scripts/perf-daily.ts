/**
 * Stage benchmark for GET /api/daily/plan on a local copy (prints timings only, no user data).
 * Usage: DATABASE_URL=… npx tsx scripts/perf-daily.ts
 */
import { prisma } from '../src/db';
import { dailyPlan } from '../src/daily';
import { leakCandidates, refreshLeakMemory } from '../src/leakMemory';
import { loadDecisionRows } from '../src/leakEngine';

const N = Number(process.env.N ?? 5);
const ms = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e6;
async function timed<T>(label: string, f: () => Promise<T>, n = N) {
  const xs: number[] = [];
  let out!: T;
  for (let i = 0; i < n; i++) {
    const t = process.hrtime.bigint();
    out = await f();
    xs.push(ms(t));
  }
  xs.sort((a, b) => a - b);
  console.log(`${label.padEnd(44)} p50 ${xs[Math.floor(xs.length / 2)]!.toFixed(0).padStart(6)} ms   max ${xs[xs.length - 1]!.toFixed(0).padStart(6)} ms  (n=${n})`);
  return out;
}

async function main() {
  const owner = (await prisma.$queryRawUnsafe<{ userId: string }[]>(`SELECT "userId" FROM "RealDecision" GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`))[0]!.userId;
  const rows = await timed('loadDecisionRows (fetch + map)', () => loadDecisionRows(owner));
  console.log(`  rows: ${rows.length}`);
  await timed('leakCandidates (fetch + analysis)', () => leakCandidates(owner));
  await timed('refreshLeakMemory (stale-memory path)', () => refreshLeakMemory(owner));
  await timed('dailyPlan, memory fresh (usual path)', () => dailyPlan(owner, 10));
  await timed('dailyPlan, memory stale (first of the day)', async () => {
    await prisma.leakMemoryState.update({ where: { userId: owner }, data: { refreshedAt: new Date(0) } });
    return dailyPlan(owner, 10);
  });
  console.log(`node ${process.version}`);
}
main().finally(() => prisma.$disconnect());
