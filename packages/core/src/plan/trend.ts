import { wilson } from '../leaks/engine';

/**
 * Period comparison (Phase 1 D5). A change is only called "supported" when a two-proportion test
 * (cluster-robust z-test; Fisher's exact test for rare events) gives two-sided p < 0.10 — and, when
 * several comparisons are made together, the Benjamini–Hochberg adjusted p is < 0.10 too.
 * Otherwise "no clear change". Small samples are "insufficient" — never a trend.
 */
export const PERIOD_DAYS = [7, 30, 60] as const;
export const MIN_PERIOD_SAMPLE = 20;

/**
 * better/worse: a statistically supported change in an ERROR rate (lower is better).
 * towardBand/awayFromBand: a statistically supported change in a FREQUENCY relative to a heuristic
 *   reference band — a behavioural change and at most a potential concern, never a verified error.
 */
export type ChangeVerdict = 'better' | 'worse' | 'towardBand' | 'awayFromBand' | 'noClearChange' | 'insufficient';
/** Fewer independent units (tournaments, days) than this in either period → insufficient. */
export const MIN_CLUSTERS = 8;

/** Standard normal CDF (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

const lnFact = (() => {
  const cache = [0];
  return (n: number) => {
    for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1]! + Math.log(i);
    return cache[n]!;
  };
})();

/** Fisher's exact test, two-sided (sum of tables no more likely than the observed one). */
export function fisherExact(k1: number, n1: number, k2: number, n2: number): number {
  const K = k1 + k2;
  const N = n1 + n2;
  const lp = (x: number) => lnFact(K) + lnFact(N - K) + lnFact(n1) + lnFact(n2) - lnFact(N) - lnFact(x) - lnFact(K - x) - lnFact(n1 - x) - lnFact(n2 - K + x);
  const obs = lp(k1);
  let p = 0;
  for (let x = Math.max(0, K - n2); x <= Math.min(K, n1); x++) {
    const l = lp(x);
    if (l <= obs + 1e-9) p += Math.exp(l);
  }
  return Math.min(1, p);
}

export interface RateChange {
  current: { k: number; n: number; rate: number | null; ci: [number, number] | null; clusters?: number };
  previous: { k: number; n: number; rate: number | null; ci: [number, number] | null; clusters?: number };
  diff: number | null;
  /** Two-sided p-value of the period difference. */
  p: number | null;
  /** Benjamini–Hochberg adjusted p (false-discovery rate) when several comparisons were made together. */
  q?: number | null;
  /** Variance inflation from clustering (1 = independent decisions). */
  designEffect?: number | null;
  method: 'z' | 'z-cluster' | 'fisher' | 'none';
  verdict: ChangeVerdict;
}

type Side = { k: number; n: number; clusters?: { k: number; n: number }[] };

/** Cluster-robust variance of a pooled proportion (ratio estimator, small-sample corrected). */
function clusterVar(s: Side, p: number): number {
  const cl = s.clusters!;
  const m = cl.length;
  if (m < 2 || s.n === 0) return Infinity;
  const ss = cl.reduce((a, c) => a + (c.k - p * c.n) ** 2, 0);
  return (m / (m - 1)) * (ss / (s.n * s.n));
}

/**
 * Compare a rate between the current and the previous period. `lowerIsBetter` for error rates;
 * for a frequency judged against a heuristic band pass `target`: the verdict is then only
 * towardBand / awayFromBand. When `clusters` are given (e.g. per tournament: decisions in one
 * tournament are not independent) the test uses cluster-robust standard errors.
 */
export function compareRates(cur: Side, prev: Side, opts: { lowerIsBetter?: boolean; target?: [number, number] } = {}): RateChange {
  const side = (x: Side) => ({ k: x.k, n: x.n, rate: x.n ? x.k / x.n : null, ci: x.n ? wilson(x.k, x.n) : null, ...(x.clusters ? { clusters: x.clusters.length } : {}) });
  const c = side(cur);
  const p = side(prev);
  const diffRaw = c.rate !== null && p.rate !== null ? Math.round((c.rate - p.rate) * 10000) / 10000 : null;
  const tooFewClusters = !!cur.clusters && !!prev.clusters && (cur.clusters.length < MIN_CLUSTERS || prev.clusters.length < MIN_CLUSTERS);
  if (cur.n < MIN_PERIOD_SAMPLE || prev.n < MIN_PERIOD_SAMPLE || tooFewClusters) return { current: c, previous: p, diff: diffRaw, p: null, method: 'none', verdict: 'insufficient' };
  const pooled = (cur.k + prev.k) / (cur.n + prev.n);
  const binVar = pooled * (1 - pooled) * (1 / cur.n + 1 / prev.n);
  const diff = c.rate! - p.rate!;
  // rare events (expected count < 5 in any cell): the normal approximation is unreliable → exact test
  const minExpected = Math.min(cur.n, prev.n) * Math.min(pooled, 1 - pooled);
  let pv: number;
  let method: RateChange['method'];
  let designEffect: number | null = null;
  if (minExpected < 5) {
    pv = fisherExact(cur.k, cur.n, prev.k, prev.n);
    method = 'fisher';
  } else if (cur.clusters && prev.clusters) {
    const v = clusterVar(cur, c.rate!) + clusterVar(prev, p.rate!);
    // never claim more precision than the independent-decision test
    const vv = Math.max(v, binVar);
    designEffect = binVar > 0 ? Math.round((vv / binVar) * 100) / 100 : null;
    pv = vv > 0 ? 2 * (1 - normCdf(Math.abs(diff) / Math.sqrt(vv))) : 1;
    method = 'z-cluster';
  } else {
    pv = binVar > 0 ? 2 * (1 - normCdf(Math.abs(diff) / Math.sqrt(binVar))) : 1;
    method = 'z';
  }
  const out: RateChange = { current: c, previous: p, diff: Math.round(diff * 10000) / 10000, p: Math.round(pv * 10000) / 10000, designEffect, method, verdict: 'noClearChange' };
  out.verdict = verdictFor(out, opts, pv);
  return out;
}

function verdictFor(r: RateChange, opts: { lowerIsBetter?: boolean; target?: [number, number] }, pv: number): ChangeVerdict {
  if (pv >= 0.1) return 'noClearChange';
  const cur = r.current.rate!;
  const prev = r.previous.rate!;
  if (opts.target) {
    const dist = (x: number) => (x < opts.target![0] ? opts.target![0] - x : x > opts.target![1] ? x - opts.target![1] : 0);
    const d0 = dist(prev);
    const d1 = dist(cur);
    return d1 < d0 ? 'towardBand' : d1 > d0 ? 'awayFromBand' : 'noClearChange';
  }
  return (opts.lowerIsBetter ?? true) === cur < prev ? 'better' : 'worse';
}

/**
 * Benjamini–Hochberg: when many comparisons are made together (every pattern in a period), keep a
 * "supported" verdict only if its FDR-adjusted p is below `alpha`. Mutates and returns the list.
 */
export function adjustForMultipleComparisons<T extends RateChange>(xs: T[], alpha = 0.1): T[] {
  const tested = xs.filter((x) => x.p !== null).sort((a, b) => a.p! - b.p!);
  const m = tested.length;
  let prevQ = 1;
  for (let i = m - 1; i >= 0; i--) {
    const q = Math.min(prevQ, (tested[i]!.p! * m) / (i + 1));
    prevQ = q;
    tested[i]!.q = Math.round(q * 10000) / 10000;
    if (q >= alpha && tested[i]!.verdict !== 'insufficient') tested[i]!.verdict = 'noClearChange';
  }
  return xs;
}

/** [from, to) ISO windows: the last `days` before `anchor`, and the equal window before that. */
export function periodWindows(anchor: Date, days: number) {
  const end = anchor.getTime();
  const d = days * 86_400_000;
  return { current: { from: new Date(end - d).toISOString(), to: new Date(end).toISOString() }, previous: { from: new Date(end - 2 * d).toISOString(), to: new Date(end - d).toISOString() } };
}
