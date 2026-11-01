import { describe, expect, it } from 'vitest';
import { GTO_STACKS, classIndex, generateGtoSpot, gradeGtoSpot, solvePushFold } from '../src/gto';

describe('push/fold Nash solver', () => {
  it('matches the published heads-up 10BB equilibrium (≈58% shove / ≈37% call)', () => {
    const s = solvePushFold({ stackBB: 10, deadBB: 0 });
    expect(s.pushPct).toBeGreaterThan(56.5);
    expect(s.pushPct).toBeLessThan(59.5);
    expect(s.callPct).toBeGreaterThan(36);
    expect(s.callPct).toBeLessThan(39);
    expect(s.exploitabilityBB).toBeLessThan(0.005);
  });
  it('ranges widen as stacks shrink and with dead antes', () => {
    const a = solvePushFold({ stackBB: 15, deadBB: 0 });
    const b = solvePushFold({ stackBB: 5, deadBB: 0 });
    const c = solvePushFold({ stackBB: 15, deadBB: 1 });
    expect(b.pushPct).toBeGreaterThan(a.pushPct);
    expect(c.pushPct).toBeGreaterThan(a.pushPct);
  });
  it('premium hands always shove and call; trash folds', () => {
    for (const S of [3, 8, 15]) {
      const s = solvePushFold({ stackBB: S, deadBB: 0 });
      for (const h of ['AA', 'KK', 'AKs']) {
        expect(s.push[classIndex(h)]).toBe(1);
        expect(s.call[classIndex(h)]).toBe(1);
      }
      expect(s.call[classIndex('72o')]).toBe(0);
    }
  });
  it('EVs are consistent with the strategy (shove iff EV > 0, up to mixing)', () => {
    const s = solvePushFold({ stackBB: 12, deadBB: 0.75 });
    s.push.forEach((f, i) => {
      if (f === 1) expect(s.evShove[i]).toBeGreaterThan(-0.02);
      if (f === 0) expect(s.evShove[i]).toBeLessThan(0.02);
    });
  });
});

describe('GTO quiz spots', () => {
  it('are deterministic per seed and inside the configured ranges', () => {
    for (let seed = 1; seed < 60; seed++) {
      const a = generateGtoSpot(seed);
      expect(generateGtoSpot(seed)).toEqual(a);
      expect(GTO_STACKS).toContain(a.stackBB);
      expect(a.heroCards[0]).not.toBe(a.heroCards[1]);
    }
    const f = generateGtoSpot(5, { minStack: 4, maxStack: 6, role: 'bbCall' });
    expect(f.role).toBe('bbCall');
    expect(f.stackBB).toBeGreaterThanOrEqual(4);
    expect(f.stackBB).toBeLessThanOrEqual(6);
  });
  it('grades by EV loss against the equilibrium', () => {
    const spot = { seed: 1, role: 'sbShove' as const, stackBB: 10, anteFormat: 'none' as const, deadBB: 0, heroCards: ['As', 'Ad'] as ['As', 'Ad'], heroClass: 'AA' };
    expect(gradeGtoSpot(spot, 'shove').grade).toBe('excellent');
    const fold = gradeGtoSpot(spot, 'fold');
    expect(fold.grade).toBe('major');
    expect(fold.evLossBB).toBeGreaterThan(2);
    const trash = { ...spot, heroCards: ['7h', '2c'] as ['7h', '2c'], heroClass: '72o', role: 'bbCall' as const };
    expect(gradeGtoSpot(trash, 'fold').grade).toBe('excellent');
    expect(() => gradeGtoSpot(trash, 'shove')).toThrow();
  });
});

describe('precomputed solutions', () => {
  it('cover every quiz configuration and equal a fresh solve', async () => {
    const { PUSHFOLD_DATA_INFO } = await import('../src/gto');
    expect(PUSHFOLD_DATA_INFO.maxExploitabilityBB).toBeLessThan(0.005);
    const pre = solvePushFold({ stackBB: 7.5, deadBB: 1 });
    const fresh = solvePushFold({ stackBB: 7.5, deadBB: 1 }, 2001);
    expect(pre.push).toEqual(fresh.push);
    expect(pre.call).toEqual(fresh.call);
  });
});
