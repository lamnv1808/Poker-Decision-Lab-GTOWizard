import { wilson } from '../leaks/engine';

/**
 * Period comparison (Phase 1 D5). A change is only called better/worse when a two-proportion test
 * (z-test; Fisher's exact test for rare events) says it is unlikely to be noise (two-sided p < 0.10, matching the 90% intervals used elsewhere);
 * otherwise "no clear change". Small samples are "insufficient" — never a trend.
 */
export const PERIOD_DAYS = [7, 30, 60] as const;
export const MIN_PERIOD_SAMPLE = 20;

export type ChangeVerdict = 'better' | 'worse' | 'noClearChange' | 'insufficient';

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
  current: { k: number; n: number; rate: number | null; ci: [number, number] | null };
  previous: { k: number; n: number; rate: number | null; ci: [number, number] | null };
  diff: number | null;
  p: number | null;
  verdict: ChangeVerdict;
}

/**
 * Compare a rate between the current and the previous period. `lowerIsBetter` for error rates;
 * for a frequency judged against a band, pass `target` (the band) and "better" means closer to it.
 */
export function compareRates(cur: { k: number; n: number }, prev: { k: number; n: number }, opts: { lowerIsBetter?: boolean; target?: [number, number] } = {}): RateChange {
  const side = (x: { k: number; n: number }) => ({ ...x, rate: x.n ? x.k / x.n : null, ci: x.n ? wilson(x.k, x.n) : null });
  const c = side(cur);
  const p = side(prev);
  if (cur.n < MIN_PERIOD_SAMPLE || prev.n < MIN_PERIOD_SAMPLE) return { current: c, previous: p, diff: c.rate !== null && p.rate !== null ? c.rate - p.rate : null, p: null, verdict: 'insufficient' };
  const pooled = (cur.k + prev.k) / (cur.n + prev.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / cur.n + 1 / prev.n));
  const diff = c.rate! - p.rate!;
  // rare events (expected count < 5 in any cell): the normal approximation is unreliable → exact test
  const minExpected = Math.min(cur.n, prev.n) * Math.min(pooled, 1 - pooled);
  const pv = minExpected < 5 ? fisherExact(cur.k, cur.n, prev.k, prev.n) : se > 0 ? 2 * (1 - normCdf(Math.abs(diff) / se)) : 1;
  let verdict: ChangeVerdict = 'noClearChange';
  if (pv < 0.1) {
    if (opts.target) {
      const dist = (r: number) => (r < opts.target![0] ? opts.target![0] - r : r > opts.target![1] ? r - opts.target![1] : 0);
      const d0 = dist(p.rate!);
      const d1 = dist(c.rate!);
      verdict = d1 < d0 ? 'better' : d1 > d0 ? 'worse' : 'noClearChange';
    } else verdict = (opts.lowerIsBetter ?? true) ? (diff < 0 ? 'better' : 'worse') : diff > 0 ? 'better' : 'worse';
  }
  return { current: c, previous: p, diff: Math.round(diff * 10000) / 10000, p: Math.round(pv * 10000) / 10000, verdict };
}

/** [from, to) ISO windows: the last `days` before `anchor`, and the equal window before that. */
export function periodWindows(anchor: Date, days: number) {
  const end = anchor.getTime();
  const d = days * 86_400_000;
  return { current: { from: new Date(end - d).toISOString(), to: new Date(end).toISOString() }, previous: { from: new Date(end - 2 * d).toISOString(), to: new Date(end - d).toISOString() } };
}
