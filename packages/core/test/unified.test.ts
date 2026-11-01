import { describe, expect, it } from 'vitest';
import { RATING_MODEL_VERSION, fundamentalsUpdate, overallProficiency, strengthsAndWeaknesses } from '../src';

describe('unified competency', () => {
  it('reports insufficient evidence instead of a number', () => {
    const p = overallProficiency({ rating: 1200, rd: 300, games: 3 }, undefined, { covered: 1, total: 11 });
    expect(p.status).toBe('insufficient');
    expect(p.rating).toBeNull();
    expect(p.modelVersion).toBe(RATING_MODEL_VERSION);
  });
  it('blends the two subratings by evidence; one well-measured track is enough', () => {
    const s = { rating: 1300, rd: 80, games: 60 };
    const f = { rating: 1000, rd: 80, games: 60 };
    const both = overallProficiency(s, f, { covered: 8, total: 11 });
    expect(both.status).toBe('ok');
    expect(both.rating!).toBeGreaterThan(1150);
    expect(both.rating!).toBeLessThan(1300);
    expect(both.confidence).toBe('high');
    const onlyF = overallProficiency({ rating: 1500, rd: 340, games: 2 }, f, { covered: 2, total: 11 });
    expect(onlyF.rating).toBe(1000);
    expect(onlyF.components.strategy).toBe(0);
  });
  it('never lists the same skill as both a strength and a weakness', () => {
    const one = strengthsAndWeaknesses([{ skill: 'preflop', rating: 1100 }]);
    expect(one.enough).toBe(false);
    expect(one.strengths).toEqual([]);
    for (let n = 2; n <= 8; n++) {
      const skills = Array.from({ length: n }, (_, i) => ({ skill: `s${i}`, rating: 1000 + i * 10 }));
      const r = strengthsAndWeaknesses(skills);
      const a = new Set(r.strengths.map((x) => x.skill));
      expect(r.weaknesses.some((x) => a.has(x.skill))).toBe(false);
    }
  });
  it('fundamentals updates are familiarity-limited and reproducible', () => {
    const a = fundamentalsUpdate(undefined, { score: 1, difficulty: 3, priorExposures: 0, daysSince: 0 })!;
    const b = fundamentalsUpdate(undefined, { score: 1, difficulty: 3, priorExposures: 0, daysSince: 0 })!;
    expect(a.after).toEqual(b.after);
    expect(a.after.rating).toBeGreaterThan(a.before.rating);
    expect(fundamentalsUpdate(undefined, { score: 1, difficulty: 3, priorExposures: 3, daysSince: 0 })).toBeNull();
  });
});
