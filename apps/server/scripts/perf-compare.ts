/** Equivalence + speed of the old and new decision loaders on a local copy (prints no user data). */
import { analyzePatterns, analyzeSolver } from '@pdl/core';
import { prisma } from '../src/db';
import { loadDecisionRows, loadDecisionRowsPrisma } from '../src/leakEngine';

const ms = (t: bigint) => Number(process.hrtime.bigint() - t) / 1e6;
const canon = (rows: unknown[]) => JSON.stringify([...rows].map((r) => JSON.stringify(r, Object.keys(r as object).sort())).sort());
const shuffle = <T,>(a: T[]) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j]!, b[i]!]; } return b; };
async function main() {
  const owner = (await prisma.$queryRawUnsafe<{ userId: string }[]>(`SELECT "userId" FROM "RealDecision" GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`))[0]!.userId;
  const times = { old: [] as number[], neu: [] as number[] };
  let a: Awaited<ReturnType<typeof loadDecisionRows>> = [], b = a;
  for (let i = 0; i < 5; i++) {
    let t = process.hrtime.bigint(); a = await loadDecisionRowsPrisma(owner); times.old.push(ms(t));
    t = process.hrtime.bigint(); b = await loadDecisionRows(owner); times.neu.push(ms(t));
  }
  const p50 = (x: number[]) => [...x].sort((m, n) => m - n)[2]!.toFixed(0);
  console.log(`rows old ${a.length} new ${b.length}; identical rows (order-insensitive): ${canon(a) === canon(b)}`);
  console.log(`analyzePatterns identical: ${JSON.stringify(analyzePatterns(a)) === JSON.stringify(analyzePatterns(b))}; analyzeSolver identical: ${JSON.stringify(analyzeSolver(a)) === JSON.stringify(analyzeSolver(b))}`);
  console.log(`order-insensitive analysis (shuffled input): ${JSON.stringify(analyzePatterns(shuffle(a))) === JSON.stringify(analyzePatterns(a)) && JSON.stringify(analyzeSolver(shuffle(a))) === JSON.stringify(analyzeSolver(a))}`);
  console.log(`p50 old ${p50(times.old)} ms, new ${p50(times.neu)} ms (n=5)`);
}
main().finally(() => prisma.$disconnect());
