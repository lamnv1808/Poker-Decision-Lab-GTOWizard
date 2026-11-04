/**
 * PKO prototype sensitivity analysis (Phase 4A). Prints a markdown table; nothing is stored.
 *   npx tsx packages/core/scripts/pko-sensitivity.ts
 * How push/fold ranges move with the bounty's chip-equivalent value (in BB), 6-max and 9-max, equal stacks,
 * 1 BB of antes. Bounty value b is an INPUT: it depends on the target's current bounty, the cash share and the
 * $/chip rate, none of which are in the hand histories.
 */
import { CLASSES, solveNmaxPushFold } from '../src';

const combos = (h: number) => (CLASSES[h]!.length === 2 ? 6 : CLASSES[h]!.endsWith('s') ? 4 : 12);
const share = (f: ArrayLike<number>) => { let s = 0; for (let h = 0; h < CLASSES.length; h++) s += f[h]! * combos(h); return s / 1326; };
const flips = (a: ArrayLike<number>, b: ArrayLike<number>) => { let s = 0; for (let h = 0; h < CLASSES.length; h++) if (Math.abs(a[h]! - b[h]!) > 0.5) s += combos(h); return s / 1326; };
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

console.log('| table | stack | bounty b (BB) | UTG shove | BTN shove | SB shove | BB calls SB | combos whose SB decision flips vs chip EV | ε (BB/hand) |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const n of [6, 9]) for (const S of [8, 15]) {
  const base = solveNmaxPushFold({ tableSize: n, stackBB: S, deadBB: 1 }, { iterations: 1500 });
  for (const b of [0, 2, 5, 10, 20]) {
    const s = b === 0 ? base : solveNmaxPushFold({ tableSize: n, stackBB: S, deadBB: 1, bountyBB: b }, { iterations: 1500 });
    const i = (p: string) => s.order.indexOf(p);
    console.log(`| ${n}-max | ${S} BB | ${b} | ${pct(share(s.shove[i('UTG')]!))} | ${pct(share(s.shove[i('BTN')]!))} | ${pct(share(s.shove[i('SB')]!))} | ${pct(share(s.call[i('SB')]![i('BB')]!))} | ${pct(flips(s.shove[i('SB')]!, base.shove[i('SB')]!))} | ${s.maxEpsilonBB.toExponential(1)} |`);
  }
}
