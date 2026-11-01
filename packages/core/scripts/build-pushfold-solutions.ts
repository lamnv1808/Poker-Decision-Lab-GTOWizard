/**
 * Precomputes the push/fold equilibrium for every quiz configuration (stacks 2–15BB in 0.5BB steps ×
 * dead-ante levels) into src/gto/pushfold-solutions.json. Run: npx tsx scripts/build-pushfold-solutions.ts
 */
import { writeFileSync } from 'node:fs';
import { ANTE_FORMATS, GTO_STACKS } from '../src/gto/quiz';
import { AUDIT_DEAD_LEVELS } from '../src/gto/audit';
import { EQUITY_METHOD, PUSHFOLD_METHOD_VERSION, solvePushFold } from '../src/gto/pushfold';

const deads = [...new Set([...Object.values(ANTE_FORMATS).map((a) => a.deadBB), ...AUDIT_DEAD_LEVELS])].sort((a, b) => a - b);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const solutions: Record<string, unknown> = {};
let worst = 0;
const t0 = Date.now();
for (const S of GTO_STACKS)
  for (const D of deads) {
    const s = solvePushFold({ stackBB: S, deadBB: D }, 2000);
    s.push = s.push.map(r3); s.call = s.call.map(r3);
    worst = Math.max(worst, s.exploitabilityBB);
    solutions[`${S}|${D}`] = { ...s, evShove: s.evShove.map(r3), evCall: s.evCall.map(r3), exploitabilityBB: Math.round(s.exploitabilityBB * 1e6) / 1e6 };
  }
writeFileSync(
  new URL('../src/gto/pushfold-solutions.json', import.meta.url),
  JSON.stringify({ methodVersion: PUSHFOLD_METHOD_VERSION, equityMethod: EQUITY_METHOD, iterations: 2000, maxExploitabilityBB: worst, solutions }),
);
console.log(`${Object.keys(solutions).length} solutions in ${((Date.now() - t0) / 1000).toFixed(1)}s; worst exploitability ${worst.toFixed(5)} BB`);
