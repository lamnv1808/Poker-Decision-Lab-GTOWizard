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
  it('with a target band, better means closer to the band', () => {
    // UTG opens 30% → 20% (band 10–24%) is better even though the rate fell
    expect(compareRates({ k: 200, n: 1000 }, { k: 300, n: 1000 }, { target: [0.1, 0.24] }).verdict).toBe('better');
    expect(compareRates({ k: 50, n: 1000 }, { k: 150, n: 1000 }, { target: [0.1, 0.24] }).verdict).toBe('worse');
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
