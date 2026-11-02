import { describe, expect, it } from 'vitest';
import { AUDIT_DEAD_LEVELS, CLASSES, callEvVs, classEquity, gradeGtoSpot, precomputedPushFoldKeys, robustness, shoveEvVs, solvePushFold } from '../src/gto';
import type { GtoSpot } from '../src/gto';

/**
 * Release gate B — push/fold mathematics, checked against independently known numbers and
 * hand-derived formulas (not against the code's own output).
 *
 * Chip-EV model (all values in BB, relative to folding):
 *   SB shove:  P(fold)·(1.5 + D) + P(call)·(eq·(2S + D) − (S − 0.5))
 *   BB call:   eq·(2S + D) − (S − 1)
 * S = effective stack incl. the posted blind, D = dead antes in the pot.
 */
const spot = (role: 'sbShove' | 'bbCall', S: number, D: number, heroClass: string) => ({ seed: 0, role, stackBB: S, anteFormat: 'none', deadBB: D, heroCards: [], heroClass }) as unknown as GtoSpot;

describe('equity table vs published all-in equities', () => {
  it.each([
    ['AA', 'KK', 0.8195, 0.006],
    ['KK', 'AKo', 0.697, 0.01],
    ['AKs', 'QQ', 0.46, 0.01],
    ['22', 'AKo', 0.525, 0.01],
    ['AA', '72o', 0.876, 0.015],
  ])('%s vs %s ≈ %s', (a, b, want, tol) => {
    expect(Math.abs(classEquity(a as string, b as string) - (want as number))).toBeLessThanOrEqual(tol as number);
    // symmetric up to ties
    expect(classEquity(a as string, b as string) + classEquity(b as string, a as string)).toBeLessThanOrEqual(1.0001);
  });
});

describe('chip-EV formulas, hand-derived', () => {
  it('a shove that is never called wins exactly the blinds plus dead money', () => {
    for (const D of [0, 0.5, 1.25]) for (const cls of ['72o', 'AA', 'T9s']) expect(shoveEvVs(cls, {}, 10, D)).toBeCloseTo(1.5 + D, 10);
  });
  it('SB AA at 10BB vs a KK-only calling range', () => {
    // given AA in the SB, 6 of the 1225 possible BB hands are KK
    const want = (1219 / 1225) * 1.5 + (6 / 1225) * (0.8195 * 20 - 9.5);
    expect(shoveEvVs('AA', { KK: 1 }, 10, 0)).toBeCloseTo(want, 2);
  });
  it('BB KK at 10BB vs an AA-only shoving range (with and without antes)', () => {
    expect(callEvVs('KK', { AA: 1 }, 10, 0)!).toBeCloseTo((1 - 0.8195) * 20 - 9, 1);
    expect(callEvVs('KK', { AA: 1 }, 10, 1)!).toBeCloseTo((1 - 0.8195) * 21 - 9, 1);
    expect(callEvVs('KK', {}, 10, 0)).toBeNull(); // never faces a shove
  });
  it('grading measures loss against the better action only', () => {
    // a clearly +EV shove: folding loses exactly evShove; shoving loses nothing
    const sol = solvePushFold({ stackBB: 10, deadBB: 0 });
    const ev = sol.evShove[CLASSES.indexOf('A8o')]!;
    expect(ev).toBeGreaterThan(1);
    expect(gradeGtoSpot(spot('sbShove', 10, 0, 'A8o'), 'fold', sol).evLossBB).toBeCloseTo(ev, 10);
    expect(gradeGtoSpot(spot('sbShove', 10, 0, 'A8o'), 'shove', sol).evLossBB).toBe(0);
  });
});

describe('equilibrium solutions (every precomputed grid point)', () => {
  const keys = precomputedPushFoldKeys();
  it('covers the audit grid: stacks 2–15 by 0.5, every ante level', () => {
    for (let S = 2; S <= 15; S += 0.5) for (const D of AUDIT_DEAD_LEVELS) expect(keys).toContain(`${S}|${D}`);
  });
  it('pure actions are best responses and exploitability is small', () => {
    for (const k of keys) {
      const [S, D] = k.split('|').map(Number) as [number, number];
      const s = solvePushFold({ stackBB: S, deadBB: D });
      expect(s.exploitabilityBB).toBeLessThan(0.02);
      s.push.forEach((p, i) => {
        if (p === 1) expect(s.evShove[i]!).toBeGreaterThan(-0.02);
        if (p === 0) expect(s.evShove[i]!).toBeLessThan(0.02);
      });
      s.call.forEach((c, j) => {
        if (c === 1) expect(s.evCall[j]!).toBeGreaterThan(-0.02);
        if (c === 0) expect(s.evCall[j]!).toBeLessThan(0.02);
      });
    }
  });
  it('shoving gets wider as stacks get shorter and as dead money grows', () => {
    for (const D of [0, 1]) for (let S = 2.5; S <= 15; S += 0.5) expect(solvePushFold({ stackBB: S, deadBB: D }).pushPct).toBeLessThanOrEqual(solvePushFold({ stackBB: S - 0.5, deadBB: D }).pushPct + 1);
    expect(solvePushFold({ stackBB: 10, deadBB: 1 }).pushPct).toBeGreaterThan(solvePushFold({ stackBB: 10, deadBB: 0 }).pushPct);
  });
});

describe('verdict robustness to the solved grid (stack ±0.5BB, ante levels)', () => {
  it('outside the grid is never robust', () => {
    expect(robustness('sbShove', 1.6, 0, 'A8o', 'fold').robust).toBe(false);
    expect(robustness('sbShove', 10, 2.4, 'A8o', 'fold').robust).toBe(false);
  });
  it('a clear mistake is robust across its grid cell', () => {
    const r = robustness('sbShove', 10.2, 0.6, 'A8o', 'fold');
    expect(r).toMatchObject({ robust: true, corners: 4 });
    expect(r.range![0]).toBeGreaterThan(1);
  });
  it('a verdict that flips inside the cell is not robust', () => {
    // find a hand whose fold is a mistake at one stack and not at the next grid stack
    let found = false;
    for (const cls of CLASSES) {
      for (let S = 3; S < 15 && !found; S += 0.5) {
        const g = (x: number) => gradeGtoSpot(spot('sbShove', x, 0, cls), 'fold').grade;
        const m = (x: number) => g(x) === 'mistake' || g(x) === 'major';
        if (m(S) !== m(S + 0.5)) {
          expect(robustness('sbShove', S + 0.25, 0, cls, 'fold').robust).toBe(false);
          found = true;
        }
      }
      if (found) break;
    }
    expect(found).toBe(true);
  });
});
