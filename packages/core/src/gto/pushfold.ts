import table from './preflop-equity.json';

/**
 * Heads-up push/fold Nash equilibrium solver (small blind vs big blind, chip EV).
 *
 * Model (always shown to users):
 *  - Action is folded to the small blind. SB may only shove all-in or fold; BB may call or fold.
 *  - Both players have the same effective stack S (in big blinds, including their blind).
 *  - Antes already posted by everyone are dead money D (in BB).
 *  - Chip EV (no ICM, no bounties). Equities come from a precomputed 169×169 all-in table.
 *
 * Solved by fictitious play; the remaining exploitability is measured and reported.
 * EVs are relative to folding at the decision point (fold = 0).
 */
export const PUSHFOLD_METHOD_VERSION = 'pushfold-hu-fp-v1';
export const CLASSES: string[] = (table as { classes: string[] }).classes;
const N = CLASSES.length;
const EQ = (table as { eq: number[] }).eq;
const W = (table as { w: number[] }).w;
export const EQUITY_METHOD = (table as { method: string }).method;

export interface PushFoldParams {
  /** Effective stack in BB, including the posted blind. */
  stackBB: number;
  /** Dead antes in the pot, in BB (sum of every player's ante). */
  deadBB: number;
}

export interface PushFoldSolution extends PushFoldParams {
  /** Shove frequency per class (SB). */
  push: number[];
  /** Call frequency per class (BB). */
  call: number[];
  /** SB EV of shoving per class vs the equilibrium calling strategy (fold = 0), in BB. */
  evShove: number[];
  /** BB EV of calling per class vs the equilibrium shoving strategy (fold = 0), in BB. */
  evCall: number[];
  /** Combined exploitability of the solution in BB per hand (lower is closer to exact equilibrium). */
  exploitabilityBB: number;
  pushPct: number;
  callPct: number;
  iterations: number;
  methodVersion: string;
}

const classCombos = (i: number) => {
  const c = CLASSES[i]!;
  return c.length === 2 ? 6 : c.endsWith('s') ? 4 : 12;
};

function sbShoveEv(i: number, call: Float64Array | number[], S: number, D: number): number {
  let num = 0;
  let den = 0;
  const win = 1.5 + D;
  const pot = 2 * S + D;
  for (let j = 0; j < N; j++) {
    const w = W[i * N + j]!;
    if (!w) continue;
    const c = call[j]!;
    num += w * ((1 - c) * win + c * (EQ[i * N + j]! * pot - (S - 0.5)));
    den += w;
  }
  return num / den;
}

/** BB EV of calling with class j, given the SB shoving strategy. Returns null if j never faces a shove. */
function bbCallEv(j: number, push: Float64Array | number[], S: number, D: number): number | null {
  let num = 0;
  let den = 0;
  const pot = 2 * S + D;
  for (let i = 0; i < N; i++) {
    const w = W[i * N + j]! * push[i]!;
    if (!w) continue;
    num += w * (EQ[j * N + i]! * pot - (S - 1));
    den += w;
  }
  return den > 0 ? num / den : null;
}

/** Expected value for SB (per dealt hand, relative to folding everything) of a strategy pair. */
function sbValue(push: ArrayLike<number>, call: ArrayLike<number>, S: number, D: number): number {
  let v = 0;
  let tot = 0;
  for (let i = 0; i < N; i++) {
    const m = classCombos(i);
    tot += m;
    if (push[i]! > 0) v += m * push[i]! * sbShoveEv(i, call as number[], S, D);
  }
  return v / tot;
}

/** BB value (per dealt hand, relative to always folding) of calling strategy vs push strategy. */
function bbValue(push: ArrayLike<number>, call: ArrayLike<number>, S: number, D: number): number {
  // Joint probability over combo pairs: weight W[i][j] / total pairs
  let v = 0;
  let tot = 0;
  const pot = 2 * S + D;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const w = W[i * N + j]!;
      tot += w;
      if (!w || !push[i] || !call[j]) continue;
      v += w * push[i]! * call[j]! * (EQ[j * N + i]! * pot - (S - 1));
    }
  return v / tot;
}

function bbValueAlwaysFold(): number {
  return 0;
}

const cache = new Map<string, PushFoldSolution>();

/** Precomputed solutions (scripts/build-pushfold-solutions.ts), registered by the app at startup. */
let precomputed: { solutions: Record<string, PushFoldSolution> } | null = null;
export function registerPushFoldSolutions(data: { solutions: Record<string, PushFoldSolution> }): void {
  precomputed = data;
}

export function solvePushFold(params: PushFoldParams, iterations = 1500): PushFoldSolution {
  const S = params.stackBB;
  const D = params.deadBB;
  if (!(S >= 1 && S <= 100) || !(D >= 0 && D <= 20)) throw new Error('Invalid push/fold parameters');
  const key = `${S}|${D}|${iterations}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pre = precomputed?.solutions[`${S}|${D}`];
  if (pre) return pre;
  const push = new Float64Array(N).fill(0.5);
  const call = new Float64Array(N).fill(0.5);
  for (let t = 1; t <= iterations; t++) {
    // best responses to the current averages
    const brCall = new Float64Array(N);
    for (let j = 0; j < N; j++) {
      const ev = bbCallEv(j, push, S, D);
      brCall[j] = ev !== null && ev > 0 ? 1 : 0;
    }
    const brPush = new Float64Array(N);
    for (let i = 0; i < N; i++) brPush[i] = sbShoveEv(i, call, S, D) > 0 ? 1 : 0;
    const a = 1 / (t + 1);
    for (let k = 0; k < N; k++) {
      push[k] = push[k]! + a * (brPush[k]! - push[k]!);
      call[k] = call[k]! + a * (brCall[k]! - call[k]!);
    }
  }
  // Clean tiny frequencies produced by averaging (report as pure where within 1%).
  const clean = (x: number) => (x < 0.01 ? 0 : x > 0.99 ? 1 : Math.round(x * 1000) / 1000);
  const p = Array.from(push, clean);
  const c = Array.from(call, clean);
  const evShove = Array.from({ length: N }, (_, i) => sbShoveEv(i, c, S, D));
  const evCall = Array.from({ length: N }, (_, j) => bbCallEv(j, p, S, D) ?? 0);
  // exploitability: what each side gains by best-responding instead of playing the solution
  const brP = evShove.map((e) => (e > 0 ? 1 : 0));
  const brC = evCall.map((e) => (e > 0 ? 1 : 0));
  const sbGain = sbValue(brP, c, S, D) - sbValue(p, c, S, D);
  const bbGain = bbValue(p, brC, S, D) - bbValue(p, c, S, D) - bbValueAlwaysFold();
  const comboShare = (f: number[]) => f.reduce((s, x, i) => s + x * classCombos(i), 0) / 1326;
  const sol: PushFoldSolution = {
    ...params,
    push: p,
    call: c,
    evShove,
    evCall,
    exploitabilityBB: Math.max(0, sbGain) + Math.max(0, bbGain),
    pushPct: Math.round(comboShare(p) * 1000) / 10,
    callPct: Math.round(comboShare(c) * 1000) / 10,
    iterations,
    methodVersion: PUSHFOLD_METHOD_VERSION,
  };
  if (cache.size > 300) cache.clear();
  cache.set(key, sol);
  return sol;
}

export function classIndex(cls: string): number {
  const i = CLASSES.indexOf(cls);
  if (i < 0) throw new Error(`Unknown class ${cls}`);
  return i;
}

/** All-in equity of a hand class against a uniformly random hand (from the 169×169 table). */
export function equityVsRandom(cls: string): number {
  const i = classIndex(cls);
  let num = 0;
  let den = 0;
  for (let j = 0; j < N; j++) {
    const w = W[i * N + j]!;
    num += w * EQ[i * N + j]!;
    den += w;
  }
  return num / den;
}

/** Whether a solution is available without solving at runtime (precomputed or cached). */
export function hasPushFoldSolution(stackBB: number, deadBB: number): boolean {
  return !!precomputed?.solutions[`${stackBB}|${deadBB}`] || cache.has(`${stackBB}|${deadBB}|1500`);
}

/** All-in equity of class `a` against class `b` (card removal averaged), from the precomputed table. */
export function classEquity(a: string, b: string): number {
  return EQ[classIndex(a) * N + classIndex(b)]!;
}

/** SB chip EV of shoving `cls` (relative to folding) against an arbitrary BB calling strategy by class. */
export function shoveEvVs(cls: string, callByClass: Record<string, number>, stackBB: number, deadBB: number): number {
  const call = CLASSES.map((c) => callByClass[c] ?? 0);
  return sbShoveEv(classIndex(cls), call, stackBB, deadBB);
}

/** BB chip EV of calling with `cls` (relative to folding) against an arbitrary SB shoving strategy by class. */
export function callEvVs(cls: string, pushByClass: Record<string, number>, stackBB: number, deadBB: number): number | null {
  const push = CLASSES.map((c) => pushByClass[c] ?? 0);
  return bbCallEv(classIndex(cls), push, stackBB, deadBB);
}

/** Precomputed solution grid keys (stack|dead), for property tests. */
export function precomputedPushFoldKeys(): string[] {
  return Object.keys(precomputed?.solutions ?? {});
}
