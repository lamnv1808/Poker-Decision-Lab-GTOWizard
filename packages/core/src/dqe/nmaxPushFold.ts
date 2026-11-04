import table from '../gto/preflop-equity.json';
import { POSITION_LAYOUTS } from '../engine/positions';

/**
 * N-player push/fold equilibrium of a RESTRICTED game (chip EV). APPROXIMATE_MODEL — not full Nash.
 *
 * Game:
 *  - N players in preflop order (UTG … BTN, SB, BB), equal effective stacks S (BB, blind included).
 *    SB has posted 0.5 BB, BB 1 BB; antes are dead money D in the pot.
 *  - The first player to act voluntarily may only shove all-in or fold; everyone after a shove may call
 *    or fold. RESTRICTION: after the first call all remaining players fold (no overcalls, no 3-way
 *    all-ins). If everyone folds to the BB, the BB wins the blinds.
 *  - Utility: chip EV, relative to folding at the decision (fold = 0).
 * Card removal: exact between the shover and the caller (combo-pair weights of the 169×169 table);
 * removal by players who folded earlier is ignored (independent blockers). Equities: the precomputed
 * 169×169 all-in table (seeded Monte Carlo, ≈±0.35% per matchup).
 * Solution: simultaneous fictitious play over every seat's strategy; quality reported as ε-Nash per
 * seat (expected gain of that seat's unilateral best response, BB per hand dealt) within this game.
 * With N = 2 the game is exactly the heads-up push/fold game already in the app (benchmark).
 */
export const NMAX_PUSHFOLD_VERSION = 'pdl-pushfold-nmax-fp-v1';
export const NMAX_APPROXIMATION =
  'Restricted game: after the first call all remaining players fold (no overcalls / multiway all-ins); blockers of players who folded earlier ignored; equal effective stacks.';

const T = table as { classes: string[]; eq: number[]; w: number[]; method: string };
const N = T.classes.length;
const EQ = Float64Array.from(T.eq);
const W = Float64Array.from(T.w);
export const NMAX_EQUITY_METHOD = T.method;
const COMBOS = Float64Array.from(T.classes, (c) => (c.length === 2 ? 6 : c.endsWith('s') ? 4 : 12));
const WSUM = Float64Array.from({ length: N }, (_, h) => {
  let s = 0;
  for (let x = 0; x < N; x++) s += W[h * N + x]!;
  return s;
});

export function preflopOrder(tableSize: number): string[] {
  const l = POSITION_LAYOUTS[tableSize];
  if (!l) throw new Error(`unsupported table size ${tableSize}`);
  return [...l.slice(2), 'SB', 'BB'];
}

export interface NmaxParams {
  tableSize: number;
  stackBB: number;
  deadBB: number;
  /**
   * PKO prototype (Phase 4A): chip-equivalent value, in BB, of the bounty collected by whoever wins an all-in.
   * Equal stacks → each player covers the other, so the winner always busts the loser. Default 0 (chip EV).
   * Split pots pay no bounty; that small effect is ignored.
   */
  bountyBB?: number;
}

export interface NmaxSolution extends NmaxParams {
  order: string[];
  /** shove[i][h]: first-in shove frequency of seat i (i < N-1) */
  shove: number[][];
  /** call[i][k][h]: call frequency of seat k facing a shove from seat i (k > i); other entries empty */
  call: number[][][];
  evShove: number[][];
  /** null where the seat never faces the shove (shover range empty) */
  evCall: (number | null)[][][];
  /** ε per seat (BB per hand dealt) and per decision node (BB per time the node is reached) */
  epsilonBySeat: number[];
  maxEpsilonBB: number;
  maxNodeGainBB: number;
  iterations: number;
  runtimeMs: number;
  method: string;
}

const blindOf = (pos: string) => (pos === 'SB' ? 0.5 : pos === 'BB' ? 1 : 0);

function shoveEvs(i: number, call: Float64Array[][], S: number, D: number, b: number[], out: Float64Array, X = 0) {
  const n = b.length;
  const win = 1.5 + D;
  for (let h = 0; h < N; h++) {
    const wsum = WSUM[h]!;
    let reach = 1;
    let ev = 0;
    for (let k = i + 1; k < n; k++) {
      const ck = call[i]![k]!;
      const pot = 2 * S + D + (1.5 - b[i]! - b[k]!) + X;
      const risk = S - b[i]!;
      let pc = 0;
      let showdown = 0;
      const row = h * N;
      for (let x = 0; x < N; x++) {
        const w = W[row + x]! * ck[x]!;
        if (!w) continue;
        pc += w;
        showdown += w * (EQ[row + x]! * pot - risk);
      }
      ev += reach * (showdown / wsum);
      reach *= 1 - pc / wsum;
    }
    out[h] = ev + reach * win;
  }
}

function callEvs(i: number, k: number, shove: Float64Array, S: number, D: number, b: number[], out: (number | null)[], X = 0) {
  const pot = 2 * S + D + (1.5 - b[i]! - b[k]!) + X;
  const risk = S - b[k]!;
  for (let x = 0; x < N; x++) {
    let den = 0;
    let num = 0;
    const row = x * N;
    for (let h = 0; h < N; h++) {
      const w = W[row + h]! * shove[h]!;
      if (!w) continue;
      den += w;
      num += w * (EQ[row + h]! * pot - risk);
    }
    out[x] = den > 0 ? num / den : null;
  }
}

const comboShare = (f: ArrayLike<number>) => {
  let s = 0;
  for (let h = 0; h < N; h++) s += f[h]! * COMBOS[h]!;
  return s / 1326;
};

/** ε-Nash diagnostics of a strategy profile (within the restricted game). */
export function nmaxExploitability(p: NmaxParams, shove: ArrayLike<number>[], call: ArrayLike<number>[][]) {
  const order = preflopOrder(p.tableSize);
  const n = order.length;
  const b = order.map(blindOf);
  const S = p.stackBB;
  const D = p.deadBB;
  const sh = shove.map((s) => Float64Array.from(s));
  const ca = call.map((row) => row.map((c) => Float64Array.from(c ?? [])));
  const eps = new Array(n).fill(0);
  let maxNode = 0;
  let reachFirst = 1; // probability that all seats before i fold first-in
  const ev = new Float64Array(N);
  for (let i = 0; i < n - 1; i++) {
    shoveEvs(i, ca, S, D, b, ev, p.bountyBB ?? 0);
    let gain = 0;
    for (let h = 0; h < N; h++) gain += (COMBOS[h]! / 1326) * (Math.max(ev[h]!, 0) - sh[i]![h]! * ev[h]!);
    eps[i] += reachFirst * gain;
    maxNode = Math.max(maxNode, gain);
    const pShove = comboShare(sh[i]!);
    let reachK = reachFirst * pShove;
    const evc: (number | null)[] = new Array(N);
    for (let k = i + 1; k < n; k++) {
      callEvs(i, k, sh[i]!, S, D, b, evc, p.bountyBB ?? 0);
      // Hero's hand distribution when facing this shove: combos weighted by compatibility with the range
      let g = 0;
      let tot = 0;
      for (let x = 0; x < N; x++) {
        let w = 0;
        for (let h = 0; h < N; h++) w += W[x * N + h]! * sh[i]![h]!;
        tot += w;
        const e = evc[x];
        if (e == null || !w) continue;
        g += w * (Math.max(e, 0) - ca[i]![k]![x]! * e);
      }
      const gainK = tot > 0 ? g / tot : 0;
      eps[k] += reachK * gainK;
      maxNode = Math.max(maxNode, gainK);
      reachK *= 1 - comboShare(ca[i]![k]!);
    }
    reachFirst *= 1 - pShove;
  }
  return { epsilonBySeat: eps, maxEpsilonBB: Math.max(...eps), maxNodeGainBB: maxNode };
}

export function solveNmaxPushFold(p: NmaxParams, opts: { iterations?: number; round?: number } = {}): NmaxSolution {
  const t0 = Date.now();
  const iterations = opts.iterations ?? 3000;
  const order = preflopOrder(p.tableSize);
  const n = order.length;
  const b = order.map(blindOf);
  const S = p.stackBB;
  const D = p.deadBB;
  if (!(S >= 1 && S <= 100) || !(D >= 0 && D <= 20)) throw new Error('invalid parameters');
  const shove = Array.from({ length: n - 1 }, () => new Float64Array(N).fill(0.5));
  const call: Float64Array[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, k) => (k > i ? new Float64Array(N).fill(0.5) : new Float64Array(0))));
  const ev = new Float64Array(N);
  const evc: (number | null)[] = new Array(N);
  const brS = Array.from({ length: n - 1 }, () => new Float64Array(N));
  const brC: Float64Array[][] = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, k) => (k > i ? new Float64Array(N) : new Float64Array(0))));
  for (let t = 1; t <= iterations; t++) {
    for (let i = 0; i < n - 1; i++) {
      shoveEvs(i, call, S, D, b, ev, p.bountyBB ?? 0);
      for (let h = 0; h < N; h++) brS[i]![h] = ev[h]! > 0 ? 1 : 0;
      for (let k = i + 1; k < n; k++) {
        callEvs(i, k, shove[i]!, S, D, b, evc, p.bountyBB ?? 0);
        for (let x = 0; x < N; x++) brC[i]![k]![x] = evc[x] != null && evc[x]! > 0 ? 1 : 0;
      }
    }
    const a = 1 / (t + 1);
    for (let i = 0; i < n - 1; i++) {
      for (let h = 0; h < N; h++) shove[i]![h] = shove[i]![h]! + a * (brS[i]![h]! - shove[i]![h]!);
      for (let k = i + 1; k < n; k++) for (let x = 0; x < N; x++) call[i]![k]![x] = call[i]![k]![x]! + a * (brC[i]![k]![x]! - call[i]![k]![x]!);
    }
  }
  // store at fixed precision; diagnostics are measured on exactly what is stored
  const dp = opts.round ?? 3;
  const r = (x: number) => Math.round(x * 10 ** dp) / 10 ** dp;
  const sh = shove.map((s) => Array.from(s, r));
  const ca = call.map((row) => row.map((c) => Array.from(c, r)));
  const evShove = sh.map((_, i) => {
    shoveEvs(i, ca.map((row) => row.map((c) => Float64Array.from(c))), S, D, b, ev, p.bountyBB ?? 0);
    return Array.from(ev, (x) => Math.round(x * 1e4) / 1e4);
  });
  const evCall = ca.map((row, i) =>
    row.map((_, k) => {
      if (k <= i || i >= n - 1) return [];
      callEvs(i, k, Float64Array.from(sh[i]!), S, D, b, evc, p.bountyBB ?? 0);
      return evc.map((x) => (x == null ? null : Math.round(x * 1e4) / 1e4));
    }),
  );
  const ex = nmaxExploitability(p, sh, ca);
  return { ...p, order, shove: sh, call: ca, evShove, evCall, ...ex, iterations, runtimeMs: Date.now() - t0, method: NMAX_PUSHFOLD_VERSION };
}

/** Build canonical range records (one per decision node) from a solution. */
export function nmaxRecords(
  sol: NmaxSolution,
  build: (r: Omit<import('./ranges').RangeRecord, 'checksum' | 'keyString' | 'schema'>) => import('./ranges').RangeRecord,
): import('./ranges').RangeRecord[] {
  const out: import('./ranges').RangeRecord[] = [];
  const n = sol.order.length;
  const pct = (x: number) => Math.round(x * 1000) / 1000;
  const method = {
    generator: 'packages/core/scripts/gen-nmax-pushfold.ts',
    version: sol.method,
    algorithm: 'simultaneous fictitious play, pure best responses, 1/(t+1) averaging',
    iterations: sol.iterations,
    exploitabilityBB: Math.round(sol.maxNodeGainBB * 1e5) / 1e5,
    equitySource: NMAX_EQUITY_METHOD,
    approximation: NMAX_APPROXIMATION,
    runtimeMs: sol.runtimeMs,
  };
  const assumptions = [
    'Chip EV; MTT; equal effective stacks; SB 0.5 BB, BB 1 BB; antes as dead money.',
    'Push/fold model: first-in players shove or fold (no limps or small raises); players facing a shove call or fold.',
    NMAX_APPROXIMATION,
    `ε-Nash within this restricted game: max ${sol.maxEpsilonBB.toExponential(2)} BB per hand per seat; max per-node gain ${sol.maxNodeGainBB.toExponential(2)} BB.`,
  ];
  const base = { format: 'MTT' as const, economics: 'chipEV' as const, tableSize: sol.tableSize, activePlayers: sol.tableSize, effStackBB: sol.stackBB, sbBB: 0.5, bbBB: 1, deadBB: sol.deadBB, opponentModel: null, rakePct: null, payout: null, bounty: null };
  const folds = (until: number) => sol.order.slice(0, until).map((pos) => ({ pos, action: 'fold' as const, toBB: null }));
  const classes = T.classes;
  for (let i = 0; i < n - 1; i++) {
    const hands = Object.fromEntries(classes.map((c, h) => { const s = pct(sol.shove[i]![h]!); return [c, { f: [pct(1 - s), s], ev: [0, sol.evShove[i]![h]!] }]; }));
    out.push(build({ key: { ...base, heroPos: sol.order[i]!, node: 'unopened', history: folds(i) }, actions: ['fold', 'shove'], hands, evidence: 'approximateModel', method, validation: { status: 'approximate', checks: [] }, source: { kind: 'computed', id: 'pdl-pushfold-nmax', locator: null }, licence: { id: 'PDL-computed', redistributable: true }, assumptions }));
    for (let k = i + 1; k < n; k++) {
      const hands2 = Object.fromEntries(classes.map((c, x) => { const f = pct(sol.call[i]![k]![x]!); return [c, { f: [pct(1 - f), f], ev: [0, sol.evCall[i]![k]![x] ?? null] }]; }));
      const history = [...folds(i), { pos: sol.order[i]!, action: 'shove' as const, toBB: sol.stackBB }, ...sol.order.slice(i + 1, k).map((pos) => ({ pos, action: 'fold' as const, toBB: null }))];
      out.push(build({ key: { ...base, heroPos: sol.order[k]!, node: 'facingShove', history }, actions: ['fold', 'call'], hands: hands2, evidence: 'approximateModel', method, validation: { status: 'approximate', checks: [] }, source: { kind: 'computed', id: 'pdl-pushfold-nmax', locator: null }, licence: { id: 'PDL-computed', redistributable: true }, assumptions }));
    }
  }
  return out;
}
