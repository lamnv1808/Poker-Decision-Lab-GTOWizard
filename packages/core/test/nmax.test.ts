import { describe, expect, it } from 'vitest';
import { CLASSES, RANGE_SCHEMA_VERSION, canonicalKey, nmaxExploitability, nmaxRecords, preflopOrder, recordChecksum, solveNmaxPushFold, solvePushFold, validateRecord, type RangeRecord } from '../src';

const build = (r: Omit<RangeRecord, 'checksum' | 'keyString' | 'schema'>): RangeRecord => {
  const rec = { ...r, schema: RANGE_SCHEMA_VERSION, keyString: canonicalKey(r.key) } as RangeRecord;
  rec.checksum = recordChecksum(rec);
  return rec;
};

describe('N-player push/fold (restricted game, APPROXIMATE_MODEL)', () => {
  it('benchmark: with 2 players it reproduces the heads-up solver already in the app', () => {
    for (const [S, D] of [[6, 0.5], [12, 1]] as const) {
      const hu = solvePushFold({ stackBB: S, deadBB: D });
      const nm = solveNmaxPushFold({ tableSize: 2, stackBB: S, deadBB: D }, { iterations: 1500 });
      let maxEv = 0;
      let maxF = 0;
      for (let h = 0; h < CLASSES.length; h++) {
        maxEv = Math.max(maxEv, Math.abs(nm.evShove[0]![h]! - hu.evShove[h]!));
        // mixed (indifferent, EV ≈ 0) hands have no unique frequency; compare the clearly decided ones
        if (Math.abs(hu.evShove[h]!) > 0.02) maxF = Math.max(maxF, Math.abs(nm.shove[0]![h]! - hu.push[h]!));
      }
      expect(maxEv).toBeLessThan(0.01); // BB
      expect(maxF).toBeLessThan(0.02);
      expect(nm.maxEpsilonBB).toBeLessThan(1e-3);
    }
  });

  it('positions follow the parser layout; every record validates; ε is measured on what is stored', () => {
    expect(preflopOrder(6)).toEqual(['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
    expect(preflopOrder(9)).toEqual(['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']);
    const sol = solveNmaxPushFold({ tableSize: 6, stackBB: 10, deadBB: 1 }, { iterations: 400 });
    const recs = nmaxRecords(sol, build);
    expect(recs).toHaveLength(5 + 15); // 5 first-in shovers + 15 caller nodes
    for (const r of recs) {
      expect(validateRecord(r)).toEqual([]);
      expect(r.evidence).toBe('approximateModel');
      expect(r.validation.status).toBe('approximate');
      expect(r.method.approximation).toMatch(/no overcalls/);
    }
    const re = nmaxExploitability({ tableSize: 6, stackBB: 10, deadBB: 1 }, sol.shove, sol.call);
    expect(re.maxEpsilonBB).toBeCloseTo(sol.maxEpsilonBB, 12);
  });

  it('later seats do not depend on how many players already folded (6-max vs 9-max)', () => {
    const a = solveNmaxPushFold({ tableSize: 6, stackBB: 8, deadBB: 1 }, { iterations: 600 });
    const b = solveNmaxPushFold({ tableSize: 9, stackBB: 8, deadBB: 1 }, { iterations: 600 });
    // the SB first-in decision (BB only behind) is identical in both
    const sbA = a.shove[a.order.indexOf('SB')]!;
    const sbB = b.shove[b.order.indexOf('SB')]!;
    for (let h = 0; h < CLASSES.length; h++) expect(Math.abs(sbA[h]! - sbB[h]!)).toBeLessThan(0.02);
  });

  it('earlier positions shove tighter than later ones (fewer players behind → wider)', () => {
    const s = solveNmaxPushFold({ tableSize: 9, stackBB: 10, deadBB: 1 }, { iterations: 600 });
    const share = (f: number[]) => f.reduce((x, v, h) => x + v * (CLASSES[h]!.length === 2 ? 6 : CLASSES[h]!.endsWith('s') ? 4 : 12), 0) / 1326;
    const shares = s.order.slice(0, -1).map((_, i) => share(s.shove[i]!));
    for (let i = 1; i < shares.length; i++) expect(shares[i]!).toBeGreaterThanOrEqual(shares[i - 1]! - 0.005);
  });
});
