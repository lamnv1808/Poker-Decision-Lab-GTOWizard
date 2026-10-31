import { type Card, cardToInt } from './cards';
import { evaluateInts } from './evaluator';
import { type Range, comboFromKey, removeBlocked } from './range';
import { createRng } from './rng';

export interface EquityResult {
  /** Hero equity share: win + tie/2, in [0,1]. */
  equity: number;
  win: number;
  tie: number;
  lose: number;
  /** "exact" = full enumeration of remaining cards; "monteCarlo" = seeded sampling. */
  method: 'exact' | 'monteCarlo';
  samples: number;
  /** Standard error of the equity estimate (0 for exact). */
  stdErr: number;
  /** Weighted villain combos remaining after card removal. */
  villainCombos: number;
}

export interface EquityOptions {
  /** Monte Carlo sample count for preflop equities (default 60,000). */
  samples?: number;
  seed?: number;
}

/**
 * Equity of a specific hero hand against a weighted villain range on a given board.
 * Postflop (3+ board cards) is enumerated exactly; preflop uses seeded Monte Carlo.
 */
export function equityVsRange(hero: readonly Card[], villain: Range, board: readonly Card[] = [], opts: EquityOptions = {}): EquityResult {
  if (hero.length !== 2) throw new Error('Hero needs exactly 2 cards');
  if (![0, 3, 4, 5].includes(board.length)) throw new Error('Board must have 0, 3, 4 or 5 cards');
  const dead = [...hero, ...board];
  const live = removeBlocked(villain, dead);
  const combos: { a: number; b: number; w: number }[] = [];
  let totalW = 0;
  for (const [k, w] of live) {
    const [a, b] = comboFromKey(k);
    combos.push({ a: cardToInt(a), b: cardToInt(b), w });
    totalW += w;
  }
  if (totalW === 0) throw new Error('Villain range is empty after card removal');
  const h = hero.map(cardToInt);
  const bd = board.map(cardToInt);

  if (board.length >= 3) {
    let win = 0;
    let tie = 0;
    let total = 0;
    const deadMask = new Set([...h, ...bd]);
    const need = 5 - bd.length;
    for (const c of combos) {
      const rest: number[] = [];
      for (let i = 0; i < 52; i++) if (!deadMask.has(i) && i !== c.a && i !== c.b) rest.push(i);
      const tally = (runout: number[]) => {
        const full = [...bd, ...runout];
        const hs = evaluateInts([...h, ...full]);
        const vs = evaluateInts([c.a, c.b, ...full]);
        if (hs > vs) win += c.w;
        else if (hs === vs) tie += c.w;
        total += c.w;
      };
      if (need === 0) tally([]);
      else if (need === 1) for (const x of rest) tally([x]);
      else for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) tally([rest[i]!, rest[j]!]);
    }
    const W = win / total;
    const T = tie / total;
    return { equity: W + T / 2, win: W, tie: T, lose: 1 - W - T, method: 'exact', samples: total, stdErr: 0, villainCombos: totalW };
  }

  const samples = opts.samples ?? 60000;
  const rng = createRng(opts.seed ?? 0x5eed);
  const cum: number[] = [];
  let acc = 0;
  for (const c of combos) {
    acc += c.w;
    cum.push(acc);
  }
  let win = 0;
  let tie = 0;
  let sumSq = 0;
  let sum = 0;
  const used = new Uint8Array(52);
  for (let s = 0; s < samples; s++) {
    const x = rng() * acc;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! > x) hi = mid;
      else lo = mid + 1;
    }
    const c = combos[lo]!;
    used.fill(0);
    used[h[0]!] = 1;
    used[h[1]!] = 1;
    used[c.a] = 1;
    used[c.b] = 1;
    const brd: number[] = [];
    while (brd.length < 5) {
      const k = Math.floor(rng() * 52);
      if (!used[k]) {
        used[k] = 1;
        brd.push(k);
      }
    }
    const hs = evaluateInts([h[0]!, h[1]!, ...brd]);
    const vs = evaluateInts([c.a, c.b, ...brd]);
    let v = 0;
    if (hs > vs) {
      win++;
      v = 1;
    } else if (hs === vs) {
      tie++;
      v = 0.5;
    }
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / samples;
  const variance = Math.max(0, sumSq / samples - mean * mean);
  return {
    equity: mean,
    win: win / samples,
    tie: tie / samples,
    lose: 1 - (win + tie) / samples,
    method: 'monteCarlo',
    samples,
    stdErr: Math.sqrt(variance / samples),
    villainCombos: totalW,
  };
}

/** Exact head-to-head equity of two specific hands (enumerates all boards when cheap enough). */
export function handVsHand(hero: readonly Card[], villain: readonly Card[], board: readonly Card[] = [], opts: EquityOptions = {}): EquityResult {
  const range: Range = new Map([[`${villain[0]}${villain[1]}`, 1]]);
  // comboKey ordering is irrelevant for removal/evaluation
  return equityVsRange(hero, range, board, opts);
}
