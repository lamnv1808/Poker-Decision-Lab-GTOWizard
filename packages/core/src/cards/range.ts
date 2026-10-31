import { type Card, RANKS, SUITS, cardToInt } from './cards';

/**
 * Ranges. A range is a map of combo key ("AsKd", higher card first) -> weight 0..1.
 * Hand classes ("AKs", "AKo", "TT") are the 169-cell grid notation.
 */
export type Combo = readonly [Card, Card];
export type Range = Map<string, number>;

const R = RANKS;

export function comboKey(a: Card, b: Card): string {
  const ia = cardToInt(a);
  const ib = cardToInt(b);
  return ia > ib ? `${a}${b}` : `${b}${a}`;
}

export function comboFromKey(key: string): Combo {
  return [key.slice(0, 2) as Card, key.slice(2, 4) as Card];
}

/** All grid hand classes in grid order (row = first rank high->low). */
export function gridClasses(): string[][] {
  const rows: string[][] = [];
  for (let i = 12; i >= 0; i--) {
    const row: string[] = [];
    for (let j = 12; j >= 0; j--) {
      if (i === j) row.push(`${R[i]}${R[j]}`);
      else if (j < i) row.push(`${R[i]}${R[j]}s`);
      else row.push(`${R[j]}${R[i]}o`);
    }
    rows.push(row);
  }
  return rows;
}

export const ALL_CLASSES: string[] = gridClasses().flat();

/** Expand a hand class ("AKs", "AKo", "AK", "TT") into concrete combos. */
export function classCombos(hand: string): Combo[] {
  const r1 = hand[0];
  const r2 = hand[1];
  const kind = hand[2];
  if (!r1 || !r2 || !R.includes(r1 as never) || !R.includes(r2 as never)) {
    throw new Error(`Invalid hand class "${hand}"`);
  }
  const out: Combo[] = [];
  if (r1 === r2) {
    if (kind) throw new Error(`Invalid pair class "${hand}"`);
    for (let a = 0; a < 4; a++)
      for (let b = a + 1; b < 4; b++) out.push([`${r1}${SUITS[b]}` as Card, `${r2}${SUITS[a]}` as Card]);
    return out;
  }
  if (R.indexOf(r1 as never) < R.indexOf(r2 as never)) throw new Error(`Write higher rank first: "${hand}"`);
  for (const s1 of SUITS)
    for (const s2 of SUITS) {
      const suited = s1 === s2;
      if (kind === 's' && !suited) continue;
      if (kind === 'o' && suited) continue;
      if (kind && kind !== 's' && kind !== 'o') throw new Error(`Invalid hand class "${hand}"`);
      out.push([`${r1}${s1}` as Card, `${r2}${s2}` as Card]);
    }
  return out;
}

export function classOfCombo(a: Card, b: Card): string {
  const ra = R.indexOf(a[0] as never);
  const rb = R.indexOf(b[0] as never);
  const [hi, lo] = ra >= rb ? [a, b] : [b, a];
  if (hi[0] === lo[0]) return `${hi[0]}${lo[0]}`;
  return `${hi[0]}${lo[0]}${hi[1] === lo[1] ? 's' : 'o'}`;
}

function expandToken(token: string): string[] {
  const t = token.trim();
  if (!t) return [];
  // explicit combo, e.g. "AsKd"
  if (/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/.test(t)) return [t];
  const dash = t.split('-');
  if (dash.length === 2) {
    const [a, b] = dash as [string, string];
    const ca = parseClass(a);
    const cb = parseClass(b);
    if (ca.pair && cb.pair) {
      const hi = Math.max(ca.i1, cb.i1);
      const lo = Math.min(ca.i1, cb.i1);
      const out: string[] = [];
      for (let i = lo; i <= hi; i++) out.push(`${R[i]}${R[i]}`);
      return out;
    }
    if (ca.i1 !== cb.i1 || ca.kind !== cb.kind || ca.pair || cb.pair) throw new Error(`Invalid range span "${t}"`);
    const hi = Math.max(ca.i2, cb.i2);
    const lo = Math.min(ca.i2, cb.i2);
    const out: string[] = [];
    for (let i = lo; i <= hi; i++) out.push(`${R[ca.i1]}${R[i]}${ca.kind}`);
    return out;
  }
  if (t.endsWith('+')) {
    const c = parseClass(t.slice(0, -1));
    const out: string[] = [];
    if (c.pair) {
      for (let i = c.i1; i <= 12; i++) out.push(`${R[i]}${R[i]}`);
    } else {
      for (let i = c.i2; i < c.i1; i++) out.push(`${R[c.i1]}${R[i]}${c.kind}`);
    }
    return out;
  }
  parseClass(t);
  return [t];
}

function parseClass(s: string): { i1: number; i2: number; kind: string; pair: boolean } {
  const m = /^([2-9TJQKA])([2-9TJQKA])([so]?)$/.exec(s);
  if (!m) throw new Error(`Invalid hand class "${s}"`);
  const i1 = R.indexOf(m[1] as never);
  const i2 = R.indexOf(m[2] as never);
  const pair = i1 === i2;
  if (pair && m[3]) throw new Error(`Invalid pair class "${s}"`);
  if (!pair && i1 < i2) throw new Error(`Write higher rank first: "${s}"`);
  return { i1, i2, kind: m[3] ?? '', pair };
}

/**
 * Parse range notation: "22+, A2s+, KTo+, QJs, 76s:0.5, AsKd".
 * Later tokens override weights of earlier ones.
 */
export function parseRange(text: string): Range {
  const range: Range = new Map();
  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const [tok, w] = part.split(':') as [string, string | undefined];
    const weight = w === undefined ? 1 : Number(w);
    if (!(weight >= 0 && weight <= 1)) throw new Error(`Invalid weight in "${part}"`);
    for (const cls of expandToken(tok)) {
      const combos: Combo[] = cls.length === 4 ? [[cls.slice(0, 2) as Card, cls.slice(2) as Card]] : classCombos(cls);
      for (const [a, b] of combos) {
        if (a === b) throw new Error(`Invalid combo "${cls}"`);
        range.set(comboKey(a, b), weight);
      }
    }
  }
  return range;
}

/** Remove combos that conflict with known cards (card removal / blockers). */
export function removeBlocked(range: Range, dead: readonly Card[]): Range {
  const deadSet = new Set(dead);
  const out: Range = new Map();
  for (const [k, w] of range) {
    const [a, b] = comboFromKey(k);
    if (deadSet.has(a) || deadSet.has(b)) continue;
    if (w > 0) out.set(k, w);
  }
  return out;
}

export function comboCount(range: Range): number {
  let n = 0;
  for (const w of range.values()) n += w;
  return n;
}

/** Fraction of all 1326 starting combos. */
export function rangePercent(range: Range): number {
  return comboCount(range) / 1326;
}

/** Collapse a range to its hand classes with the fraction of each class present (0..1). */
export function rangeToClassWeights(range: Range): Map<string, number> {
  const totals = new Map<string, number>();
  for (const [k, w] of range) {
    const [a, b] = comboFromKey(k);
    const cls = classOfCombo(a, b);
    totals.set(cls, (totals.get(cls) ?? 0) + w);
  }
  const out = new Map<string, number>();
  for (const [cls, w] of totals) out.set(cls, w / classCombos(cls).length);
  return out;
}

export function classesToRange(classes: Iterable<string>): Range {
  const range: Range = new Map();
  for (const cls of classes) for (const [a, b] of classCombos(cls)) range.set(comboKey(a, b), 1);
  return range;
}
