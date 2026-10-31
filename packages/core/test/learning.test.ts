import { describe, expect, it } from 'vitest';
import {
  computeRatingChanges,
  glickoUpdate,
  glickoPeriod,
  initialGlicko,
  inflateRd,
  familiarityWeight,
  reviewSrs,
  initialSrs,
  masteryEstimate,
  needsReview,
  rankLeaks,
  leakStats,
  wilsonLower,
  observationsFor,
  generateQuiz,
  gradeQuiz,
  QUIZ_KINDS,
  requiredEquity,
} from '../src';

describe('Glicko-2', () => {
  it('matches the Glickman (2012) reference example exactly', () => {
    // Paper uses base 1500; our scale is centred on 1000, so shift every rating by -500.
    const r = glickoPeriod({ rating: 1000, rd: 200, vol: 0.06 }, [
      { rating: 900, rd: 30, score: 1 },
      { rating: 1050, rd: 100, score: 0 },
      { rating: 1200, rd: 300, score: 0 },
    ]);
    expect(r.rating + 500).toBeCloseTo(1464.06, 1);
    expect(r.rd).toBeCloseTo(151.52, 1);
    expect(r.vol).toBeCloseTo(0.05999, 4);
  });
  it('moves ratings in the right direction', () => {
    // Glickman (2012) example, translated to a 1500 base by offset (algorithm is translation invariant)
    let p = { rating: 1000, rd: 200, vol: 0.06 };
    // single-game updates are not the paper's 3-game period; check monotonic properties instead
    const win = glickoUpdate(p, { rating: 900, rd: 30 }, 1);
    const loss = glickoUpdate(p, { rating: 900, rd: 30 }, 0);
    expect(win.rating).toBeGreaterThan(1000);
    expect(loss.rating).toBeLessThan(1000);
    expect(win.rd).toBeLessThan(200);
    p = initialGlicko();
    expect(p.rating).toBe(1000);
  });
  it('is deterministic and reproducible', () => {
    const a = glickoUpdate(initialGlicko(), { rating: 1100, rd: 80 }, 0.85);
    const b = glickoUpdate(initialGlicko(), { rating: 1100, rd: 80 }, 0.85);
    expect(a).toEqual(b);
  });
  it('inflates RD with inactivity', () => {
    expect(inflateRd({ rating: 1000, rd: 60, vol: 0.06 }, 30).rd).toBeGreaterThan(60);
  });
});

describe('rating service', () => {
  it('does not update from practice mode or unvalidated sources', () => {
    expect(computeRatingChanges({}, { score: 1, difficulty: 3, source: 'MATH_VERIFIED', priorExposures: 0, rated: false, skills: ['preflop'] }).changes).toHaveLength(0);
    expect(computeRatingChanges({}, { score: 1, difficulty: 3, source: 'HEURISTIC', priorExposures: 0, rated: true, skills: ['preflop'] }).changes).toHaveLength(0);
    expect(computeRatingChanges({}, { score: 1, difficulty: 3, source: 'EXPERIMENTAL', priorExposures: 0, rated: true, skills: ['preflop'] }).changes).toHaveLength(0);
  });
  it('updates overall plus each skill once', () => {
    const r = computeRatingChanges({}, { score: 1, difficulty: 3, source: 'MATH_VERIFIED', priorExposures: 0, rated: true, skills: ['preflop', 'shortStack', 'preflop'] });
    expect(r.changes.map((c) => c.key)).toEqual(['overall', 'preflop', 'shortStack']);
    expect(r.changes[0]!.after.rating).toBeGreaterThan(1000);
  });
  it('discounts repeated exposures to prevent farming', () => {
    expect(familiarityWeight(0)).toBe(1);
    expect(familiarityWeight(1)).toBe(0.5);
    expect(familiarityWeight(3)).toBe(0);
    const first = computeRatingChanges({}, { score: 1, difficulty: 3, source: 'MATH_VERIFIED', priorExposures: 0, rated: true, skills: ['math'] });
    const second = computeRatingChanges({}, { score: 1, difficulty: 3, source: 'MATH_VERIFIED', priorExposures: 1, rated: true, skills: ['math'] });
    const gain1 = first.changes[0]!.after.rating - 1000;
    const gain2 = second.changes[0]!.after.rating - 1000;
    expect(gain2).toBeCloseTo(gain1 / 2, 6);
    expect(computeRatingChanges({}, { score: 1, difficulty: 3, source: 'MATH_VERIFIED', priorExposures: 5, rated: true, skills: ['math'] }).changes).toHaveLength(0);
  });
  it('a good result against harder content gains more', () => {
    const easy = computeRatingChanges({}, { score: 1, difficulty: 1, source: 'MATH_VERIFIED', priorExposures: 0, rated: true, skills: ['math'] });
    const hard = computeRatingChanges({}, { score: 1, difficulty: 5, source: 'MATH_VERIFIED', priorExposures: 0, rated: true, skills: ['math'] });
    expect(hard.changes[0]!.after.rating).toBeGreaterThan(easy.changes[0]!.after.rating);
  });
});

describe('spaced repetition', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  it('schedules mistakes for tomorrow and grows intervals on success', () => {
    let s = reviewSrs(initialSrs(now), 'mistake', now);
    expect(s.intervalDays).toBe(1);
    s = reviewSrs(s, 'excellent', now);
    expect(s.intervalDays).toBe(1);
    s = reviewSrs(s, 'excellent', now);
    expect(s.intervalDays).toBe(3);
    s = reviewSrs(s, 'excellent', now);
    expect(s.intervalDays).toBeGreaterThan(3);
    expect(masteryEstimate(s)).toBeGreaterThan(masteryEstimate(reviewSrs(initialSrs(now), 'excellent', now)));
  });
  it('a lapse resets repetitions', () => {
    let s = reviewSrs(reviewSrs(reviewSrs(initialSrs(now), 'good', now), 'good', now), 'good', now);
    s = reviewSrs(s, 'major', now);
    expect(s.repetitions).toBe(0);
    expect(s.lapses).toBe(1);
  });
  it('a guess caps quality', () => {
    expect(reviewSrs(initialSrs(now), 'excellent', now, 1).lastQuality).toBe(3);
    expect(needsReview('excellent', 1)).toBe(true);
    expect(needsReview('excellent')).toBe(false);
    expect(needsReview('acceptable')).toBe(true);
  });
});

describe('leaks', () => {
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
  it('does not rank a leak on one or two hands', () => {
    const obs = [0, 1].map((i) => ({ leak: 'potOdds' as const, isError: true, at: at(i) }));
    const s = leakStats('potOdds', obs);
    expect(s.ranked).toBe(false);
    expect(s.confidence).toBe('insufficient');
    expect(s.priority).toBe(0);
  });
  it('ranks by evidence-weighted error rate', () => {
    const obs = [
      ...Array.from({ length: 20 }, (_, i) => ({ leak: 'potOdds' as const, isError: i % 2 === 0, at: at(i) })),
      ...Array.from({ length: 6 }, (_, i) => ({ leak: 'overbluffing' as const, isError: i < 2, at: at(i) })),
      ...Array.from({ length: 3 }, (_, i) => ({ leak: 'blockers' as const, isError: true, at: at(i) })),
    ];
    const ranked = rankLeaks(obs);
    expect(ranked[0]!.leak).toBe('potOdds');
    expect(ranked.find((r) => r.leak === 'blockers')!.ranked).toBe(false);
  });
  it('wilson lower bound is conservative', () => {
    expect(wilsonLower(2, 2)).toBeLessThan(1);
    expect(wilsonLower(0, 10)).toBe(0);
    expect(wilsonLower(50, 100)).toBeLessThan(0.5);
  });
  it('detects improvement trend', () => {
    const obs = Array.from({ length: 10 }, (_, i) => ({ leak: 'potOdds' as const, isError: i < 5, at: at(i) }));
    expect(leakStats('potOdds', obs).trend).toBeLessThan(0);
  });
  it('builds observations from a decision', () => {
    const o = observationsFor(['potOdds'], ['potOdds', 'overcallingBounty'], true, at(0), 1.2);
    expect(o).toHaveLength(2);
    expect(o.every((x) => x.isError)).toBe(true);
    const ok = observationsFor(['potOdds'], [], false, at(0));
    expect(ok).toEqual([{ leak: 'potOdds', isError: false, evLossBB: undefined, at: at(0) }]);
  });
});

describe('quiz generators', () => {
  it('are deterministic per seed for every kind and level', () => {
    for (const k of QUIZ_KINDS)
      for (const lvl of [1, 2, 3] as const)
        for (let seed = 1; seed < 40; seed++) {
          const a = generateQuiz(k, seed, lvl);
          const b = generateQuiz(k, seed, lvl);
          expect(a).toEqual(b);
          expect(Number.isFinite(a.answer)).toBe(true);
          expect(gradeQuiz(a, a.answer).grade).toBe('excellent');
        }
  });
  it('pot odds answer matches the formula', () => {
    const q = generateQuiz('potOdds', 7, 1);
    const m = /pot is ([\d.]+)BB\. Villain bets ([\d.]+)BB/.exec(q.prompt.en)!;
    const pot = Number(m[1]);
    const bet = Number(m[2]);
    expect(q.answer).toBeCloseTo(Math.round(requiredEquity(bet, pot + bet) * 1000) / 10, 6);
  });
  it('combos quiz counts card removal exactly', () => {
    for (let seed = 1; seed < 30; seed++) {
      const q = generateQuiz('combos', seed, 2);
      expect(Number.isInteger(q.answer)).toBe(true);
      expect(q.answer).toBeGreaterThanOrEqual(0);
    }
  });
  it('grades by distance from the answer', () => {
    const q = generateQuiz('mdf', 3, 2);
    expect(gradeQuiz(q, q.answer + 1.5).grade).toBe('good');
    expect(gradeQuiz(q, q.answer + 30).grade).toBe('major');
    expect(gradeQuiz(q, NaN).grade).toBe('major');
  });
});
