import { describe, expect, it } from 'vitest';
import { type DecisionRow, MIN_SAMPLE, analyzePatterns, analyzeSolver, classifySolver, wilson } from '../src';

let id = 0;
const row = (o: Partial<DecisionRow>): DecisionRow => ({ id: `d${id++}`, playedAt: '2026-10-01T00:00:00Z', street: 'preflop', position: 'UTG', actionContext: 'unopened', heroAction: 'fold', stackBucket: '40+', formatGroup: 'regular', facingBetPct: null, requiredEq: null, multiway: false, pfAudit: null, ...o });
const utgOpens = (opens: number, folds: number) => [...Array.from({ length: opens }, () => row({ heroAction: 'raise' })), ...Array.from({ length: folds }, () => row({ heroAction: 'fold' }))];
const rfiUtg = (rows: DecisionRow[]) => analyzePatterns(rows).find((r) => r.key === 'rfi:UTG')!;

describe('leak engine v2 — statistics', () => {
  it('Wilson interval is correct and narrows with sample size', () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeCloseTo(0.418, 2);
    expect(hi).toBeCloseTo(0.582, 2);
    expect(wilson(500, 1000)[1] - wilson(500, 1000)[0]).toBeLessThan(hi - lo);
  });
  it('never judges below the minimum sample', () => {
    const r = rfiUtg(utgOpens(MIN_SAMPLE - 5, 0)); // 100% opens but tiny sample
    expect(r.verdict).toBe('insufficient');
    expect(r.confidence).toBeNull();
  });
  it('flags a pattern only when the whole interval is outside the band', () => {
    expect(rfiUtg(utgOpens(40, 60)).verdict).toBe('suspectedHigh'); // 40% UTG opens, band 10–24%
    expect(rfiUtg(utgOpens(18, 82)).verdict).toBe('within');
    // borderline: 28% with n=50 — interval still overlaps the band → not flagged
    expect(rfiUtg(utgOpens(14, 36)).verdict).toBe('within');
    expect(rfiUtg(utgOpens(1, 99)).verdict).toBe('suspectedLow');
  });
  it('descriptive patterns (calling all-ins) never get a verdict', () => {
    const rows = Array.from({ length: 80 }, (_, i) => row({ actionContext: 'vsAllIn', requiredEq: 0.45, heroAction: i % 2 ? 'call' : 'fold' }));
    const r = analyzePatterns(rows).filter((x) => x.key === 'callAllIn');
    expect(r.every((x) => x.verdict === 'descriptive' && x.evidence === 'descriptive')).toBe(true);
  });
  it('severity ranks frequent deviations above rare ones', () => {
    const many = rfiUtg(utgOpens(160, 240));
    const few = rfiUtg(utgOpens(40, 60));
    expect(many.severity).toBeGreaterThan(0);
    expect(many.confidence).toBe('high');
    expect(few.confidence).not.toBe('high');
  });
});

describe('leak engine v2 — solver evidence and PKO', () => {
  const pf = (heroAction: 'shove' | 'call' | 'fold', grade: string, ev: number, role: 'sbShove' | 'bbCall' = 'sbShove') => ({ role, stackBB: 10, heroAction, grade, evLossBB: ev, bestAction: heroAction === 'fold' ? (role === 'sbShove' ? 'shove' : 'call') : 'fold', heroClass: 'K9o', robust: true, evLossRangeBB: [ev * 0.8, ev * 1.2] as [number, number] });
  it('a mistake the grid rounding could have produced is never verified', () => {
    expect(classifySolver(row({ pfAudit: { ...pf('fold', 'mistake', 0.8), robust: false } }))).toBe('nearThreshold');
    // legacy rows without the robustness check are not verified either
    const { robust: _r, ...legacy } = pf('fold', 'mistake', 0.8);
    expect(classifySolver(row({ pfAudit: legacy }))).toBe('nearThreshold');
  });
  it('folding where chip EV says shove/call stays verified in PKO; aggressive mistakes there are inconclusive', () => {
    expect(classifySolver(row({ formatGroup: 'PKO', pfAudit: pf('fold', 'mistake', 0.8) }))).toBe('verified');
    expect(classifySolver(row({ formatGroup: 'PKO', pfAudit: pf('shove', 'major', 1.2) }))).toBe('inconclusiveBounty');
    expect(classifySolver(row({ formatGroup: 'regular', pfAudit: pf('shove', 'major', 1.2) }))).toBe('verified');
    expect(classifySolver(row({ pfAudit: pf('shove', 'good', 0.1) }))).toBe('correct');
  });
  it('sums EV loss only over verified mistakes and groups by role, direction and stack band', () => {
    const rows = [
      row({ formatGroup: 'PKO', pfAudit: pf('fold', 'mistake', 0.8) }),
      row({ formatGroup: 'PKO', pfAudit: pf('fold', 'major', 1.5) }),
      row({ formatGroup: 'PKO', pfAudit: pf('shove', 'major', 2) }), // inconclusive
      row({ formatGroup: 'regular', pfAudit: pf('call', 'mistake', 0.6, 'bbCall') }),
      row({ pfAudit: pf('shove', 'excellent', 0) }),
    ];
    const s = analyzeSolver(rows);
    expect(s.graded).toBe(5);
    expect(s.verifiedMistakes).toBe(3);
    expect(s.inconclusive).toBe(1);
    expect(s.evLossBB).toBeCloseTo(2.9, 5);
    const tight = s.findings.find((f) => f.key === 'pf:sbShove:tooTight:6.5–10')!;
    expect(tight.n).toBe(2);
    expect(tight.evLossBB).toBeCloseTo(2.3, 5);
    expect(s.findings.find((f) => f.key === 'pf:sbShove:tooLoose:6.5–10')!.n).toBe(0);
  });
});
