import { describe, expect, it } from 'vitest';
import { compareRates, normCdf, periodWindows } from '../src/plan';

describe('period comparison', () => {
  it('normal CDF matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.645)).toBeCloseTo(0.95, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it('calls a change only when it is unlikely to be noise', () => {
    // 10% vs 20% error rate on 400 each: clearly better
    expect(compareRates({ k: 40, n: 400 }, { k: 80, n: 400 }).verdict).toBe('better');
    expect(compareRates({ k: 80, n: 400 }, { k: 40, n: 400 }).verdict).toBe('worse');
    // same difference on 30 each: not distinguishable from noise
    expect(compareRates({ k: 3, n: 30 }, { k: 6, n: 30 }).verdict).toBe('noClearChange');
    // tiny samples are never a trend
    expect(compareRates({ k: 0, n: 10 }, { k: 9, n: 10 }).verdict).toBe('insufficient');
  });
  it('rare events use the exact test (0/68 vs 2/50 is not a clear change)', () => {
    expect(compareRates({ k: 0, n: 68 }, { k: 2, n: 50 }, { lowerIsBetter: true }).verdict).toBe('noClearChange');
    // a large rare-event difference still registers
    expect(compareRates({ k: 0, n: 300 }, { k: 12, n: 300 }, { lowerIsBetter: true }).verdict).toBe('better');
  });
  it('with a heuristic band, a frequency change is only toward/away from the band — never better/worse', () => {
    expect(compareRates({ k: 200, n: 1000 }, { k: 300, n: 1000 }, { target: [0.1, 0.24] }).verdict).toBe('towardBand');
    expect(compareRates({ k: 50, n: 1000 }, { k: 150, n: 1000 }, { target: [0.1, 0.24] }).verdict).toBe('awayFromBand');
  });
  it('clustered decisions (one tournament = one unit) widen the test', () => {
    // 1000 decisions per period in 20 tournaments; rates move 30% → 34%. Independent test: p ≈ 0.06.
    const mk = (rates: number[]) => rates.map((r) => ({ k: Math.round(r * 50), n: 50 }));
    const flat = (cl: { k: number; n: number }[]) => ({ k: cl.reduce((a, c) => a + c.k, 0), n: cl.reduce((a, c) => a + c.n, 0), clusters: cl });
    // strongly heterogeneous tournaments (some very loose, some very tight)
    const prev = flat(mk([0.1, 0.5, 0.1, 0.5, 0.1, 0.5, 0.1, 0.5, 0.1, 0.5, 0.1, 0.5, 0.1, 0.5, 0.1, 0.5, 0.1, 0.5, 0.1, 0.5]));
    const cur = flat(mk([0.14, 0.54, 0.14, 0.54, 0.14, 0.54, 0.14, 0.54, 0.14, 0.54, 0.14, 0.54, 0.14, 0.54, 0.14, 0.54, 0.14, 0.54, 0.14, 0.54]));
    const plain = compareRates({ k: cur.k, n: cur.n }, { k: prev.k, n: prev.n }, { lowerIsBetter: true });
    const cl = compareRates(cur, prev, { lowerIsBetter: true });
    expect(plain.method).toBe('z');
    expect(cl.method).toBe('z-cluster');
    expect(cl.designEffect!).toBeGreaterThan(1);
    expect(cl.p!).toBeGreaterThan(plain.p!);
    // too few independent units → insufficient
    expect(compareRates(flat(mk([0.2, 0.3, 0.4])), flat(mk([0.2, 0.3, 0.4])), {}).verdict).toBe('insufficient');
  });
  it('Benjamini–Hochberg keeps only comparisons that survive the false-discovery correction', async () => {
    const { adjustForMultipleComparisons } = await import('../src/plan');
    const mk = (p: number): import('../src/plan').RateChange => ({ current: { k: 0, n: 0, rate: 0, ci: null }, previous: { k: 0, n: 0, rate: 0, ci: null }, diff: 0, p, method: 'z', verdict: 'worse' });
    const xs = [mk(0.001), mk(0.04), mk(0.08), mk(0.5)];
    adjustForMultipleComparisons(xs, 0.1);
    // q = p·m/rank with monotonicity: 0.004, 0.08, 0.1067, 0.5
    expect(xs.map((x) => x.q)).toEqual([0.004, 0.08, 0.1067, 0.5]);
    expect(xs.map((x) => x.verdict)).toEqual(['worse', 'worse', 'noClearChange', 'noClearChange']);
  });
  it('windows are consecutive and equal', () => {
    const w = periodWindows(new Date('2026-10-31T00:00:00Z'), 30);
    expect(w.current.to).toBe('2026-10-31T00:00:00.000Z');
    expect(w.previous.to).toBe(w.current.from);
    expect(w.previous.from).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('fisherExact', () => {
  it('matches reference values', async () => {
    const { fisherExact } = await import('../src/plan');
    // R: fisher.test(matrix(c(1,9,11,3),2))$p.value = 0.002759
    expect(fisherExact(1, 10, 11, 14)).toBeCloseTo(0.002759, 4);
    expect(fisherExact(5, 10, 5, 10)).toBeCloseTo(1, 6);
  });
});
