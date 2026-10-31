import { type Card, cardToInt } from './cards';

/**
 * Hand evaluator for 5–7 cards. Returns an integer score; higher is better and
 * equal scores tie. Layout: category << 20 | five 4-bit rank slots.
 * Categories: 0 high card .. 8 straight flush.
 */
export const HAND_CATEGORIES = [
  'highCard',
  'pair',
  'twoPair',
  'trips',
  'straight',
  'flush',
  'fullHouse',
  'quads',
  'straightFlush',
] as const;
export type HandCategory = (typeof HAND_CATEGORIES)[number];

function straightHigh(mask: number): number {
  for (let hi = 12; hi >= 4; hi--) {
    const m = 0x1f << (hi - 4);
    if ((mask & m) === m) return hi;
  }
  // wheel A-2-3-4-5
  if ((mask & 0x100f) === 0x100f) return 3;
  return -1;
}

function pack(category: number, ranks: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i++) score = score * 16 + (ranks[i] ?? 0);
  return score;
}

function topBits(mask: number, n: number): number[] {
  const out: number[] = [];
  for (let r = 12; r >= 0 && out.length < n; r--) if (mask & (1 << r)) out.push(r);
  return out;
}

/** Evaluate integer-encoded cards (0..51). */
export function evaluateInts(cards: readonly number[]): number {
  const counts = new Array<number>(13).fill(0);
  const suitMask = [0, 0, 0, 0];
  const suitCount = [0, 0, 0, 0];
  let all = 0;
  for (const c of cards) {
    const r = c >> 2;
    const s = c & 3;
    counts[r]!++;
    suitMask[s]! |= 1 << r;
    suitCount[s]!++;
    all |= 1 << r;
  }
  for (let s = 0; s < 4; s++) {
    if (suitCount[s]! >= 5) {
      const sh = straightHigh(suitMask[s]!);
      if (sh >= 0) return pack(8, [sh]);
      return pack(5, topBits(suitMask[s]!, 5));
    }
  }
  let quad = -1;
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let r = 12; r >= 0; r--) {
    const n = counts[r]!;
    if (n === 4) quad = r;
    else if (n === 3) trips.push(r);
    else if (n === 2) pairs.push(r);
  }
  if (quad >= 0) return pack(7, [quad, ...topBits(all & ~(1 << quad), 1)]);
  if (trips.length > 0 && (trips.length > 1 || pairs.length > 0)) {
    const t = trips[0]!;
    const p = Math.max(trips[1] ?? -1, pairs[0] ?? -1);
    return pack(6, [t, p]);
  }
  const sh = straightHigh(all);
  if (sh >= 0) return pack(4, [sh]);
  if (trips.length > 0) {
    const t = trips[0]!;
    return pack(3, [t, ...topBits(all & ~(1 << t), 2)]);
  }
  if (pairs.length >= 2) {
    const [a, b] = [pairs[0]!, pairs[1]!];
    return pack(2, [a, b, ...topBits(all & ~(1 << a) & ~(1 << b), 1)]);
  }
  if (pairs.length === 1) {
    const p = pairs[0]!;
    return pack(1, [p, ...topBits(all & ~(1 << p), 3)]);
  }
  return pack(0, topBits(all, 5));
}

export function evaluate(cards: readonly Card[]): number {
  if (cards.length < 5 || cards.length > 7) throw new Error('evaluate() needs 5-7 cards');
  return evaluateInts(cards.map(cardToInt));
}

export function categoryOf(score: number): HandCategory {
  return HAND_CATEGORIES[Math.floor(score / 16 ** 5)]!;
}
