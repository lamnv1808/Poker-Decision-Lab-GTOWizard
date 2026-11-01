import { type Card, cardToInt, fullDeck, rankOf, suitOf } from '../cards/cards';
import { evaluateInts } from '../cards/evaluator';
import { classOfCombo } from '../cards/range';
import { equityVsRandom } from '../gto/pushfold';

/** The 1326 two-card combos in a fixed order; ranges are weight vectors over this list. */
export const COMBOS: [Card, Card][] = (() => {
  const d = fullDeck();
  const out: [Card, Card][] = [];
  for (let i = 0; i < d.length; i++) for (let j = i + 1; j < d.length; j++) out.push([d[i]!, d[j]!]);
  return out;
})();
const COMBO_INTS = COMBOS.map(([a, b]) => [cardToInt(a), cardToInt(b)] as const);
const INDEX = new Map(COMBOS.map(([a, b], i) => [`${a}${b}`, i]));

export function comboIndex(a: Card, b: Card): number {
  return INDEX.get(`${a}${b}`) ?? INDEX.get(`${b}${a}`)!;
}
export const comboClass = (i: number) => classOfCombo(COMBOS[i]![0], COMBOS[i]![1]);
export const comboInts = (i: number) => COMBO_INTS[i]!;

/**
 * Preflop: share of all combos that are at least as strong (by all-in equity vs a random hand).
 * 0 = the very best hand, 1 = the worst. "Top 20%" means topShare ≤ 0.2.
 */
export const PREFLOP_TOP_SHARE: Float64Array = (() => {
  const classes = new Map<string, { eq: number; n: number }>();
  COMBOS.forEach((_, i) => {
    const c = comboClass(i);
    const e = classes.get(c) ?? { eq: equityVsRandom(c), n: 0 };
    e.n++;
    classes.set(c, e);
  });
  const sorted = [...classes].sort((a, b) => b[1].eq - a[1].eq);
  const share = new Map<string, number>();
  let above = 0;
  for (const [c, e] of sorted) {
    share.set(c, (above + e.n / 2) / COMBOS.length);
    above += e.n;
  }
  return Float64Array.from(COMBOS.map((_, i) => share.get(comboClass(i))!));
})();

function flushDraw(hole: readonly Card[], board: readonly Card[]): boolean {
  for (let s = 0; s < 4; s++) {
    const n = [...hole, ...board].filter((c) => suitOf(c) === s).length;
    if (n === 4 && hole.some((c) => suitOf(c) === s)) return true;
  }
  return false;
}
function straightDraw(hole: readonly Card[], board: readonly Card[]): boolean {
  const ranks = new Set([...hole, ...board].map(rankOf));
  if (ranks.has(12)) ranks.add(-1);
  const holeRanks = new Set(hole.flatMap((c) => (rankOf(c) === 12 ? [12, -1] : [rankOf(c)])));
  for (let lo = -1; lo <= 8; lo++) {
    const win = [0, 1, 2, 3, 4].map((k) => lo + k);
    if (win.filter((r) => ranks.has(r)).length === 4 && win.some((r) => holeRanks.has(r))) return true;
  }
  return false;
}

const postflopCache = new Map<string, Float64Array>();

/**
 * Postflop strength of every combo on a board, in [0,1]: the share of possible opposing hands it
 * currently beats (ties count half), plus a bonus for flush / straight draws before the river.
 * Combos that use a board card get NaN. This is a heuristic hand-strength measure, not equity.
 */
export function postflopStrength(board: readonly Card[]): Float64Array {
  const key = board.join('');
  const hit = postflopCache.get(key);
  if (hit) return hit;
  const b = board.map(cardToInt);
  const used = new Set(b);
  const scores = new Float64Array(COMBOS.length).fill(NaN);
  const live: number[] = [];
  COMBO_INTS.forEach(([x, y], i) => {
    if (used.has(x) || used.has(y)) return;
    scores[i] = evaluateInts([x, y, ...b]);
    live.push(i);
  });
  const sorted = live.map((i) => scores[i]!).sort((p, q) => p - q);
  const lowerBound = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (sorted[m]! < v) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const upperBound = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (sorted[m]! <= v) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  const out = new Float64Array(COMBOS.length).fill(NaN);
  const river = board.length >= 5;
  for (const i of live) {
    const v = scores[i]!;
    const lo = lowerBound(v);
    const eq = upperBound(v) - lo;
    let s = (lo + (eq - 1) / 2) / Math.max(1, sorted.length - 1);
    if (!river) {
      const hole = COMBOS[i]!;
      if (flushDraw(hole, board)) s += 0.15;
      else if (straightDraw(hole, board)) s += 0.1;
    }
    out[i] = Math.min(1, s);
  }
  if (postflopCache.size > 200) postflopCache.clear();
  postflopCache.set(key, out);
  return out;
}
