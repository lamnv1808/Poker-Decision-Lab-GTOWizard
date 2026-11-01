import { describe, expect, it } from 'vitest';
import { ITEM_SECONDS, type PlanLeak, buildDailyPlan, drillItems, leakPriority } from '../src/plan';

const now = new Date('2026-11-01T12:00:00Z');
const leak = (o: Partial<PlanLeak> = {}): PlanLeak => ({
  leakKey: 'pattern:rfi:UTG',
  label: { en: 'UTG open', vi: 'Mở UTG' },
  evidence: 'pattern',
  status: 'active',
  severity: 0.5,
  confidence: 'medium',
  timesDetected: 1,
  recentN: 100,
  drill: 'scenario:preflop',
  examples: ['d1', 'd2'],
  drillCount: 0,
  lastDrilledAt: null,
  lastDrillAccuracy: null,
  reviewDueAt: null,
  ...o,
});

describe('leakPriority', () => {
  it('is the product of its visible parts and orders as documented', () => {
    const p = leakPriority(leak(), now);
    expect(p.score).toBeCloseTo(p.severity * p.confidence * p.recurrence * p.learning, 2);
    // more severe, more confident, recurring and due → higher
    expect(leakPriority(leak({ severity: 0.9 }), now).score).toBeGreaterThan(p.score);
    expect(leakPriority(leak({ confidence: 'high' }), now).score).toBeGreaterThan(p.score);
    expect(leakPriority(leak({ timesDetected: 4 }), now).score).toBeGreaterThan(p.score);
    // drilled well and not yet due → waits its turn
    const notDue = leakPriority(leak({ drillCount: 2, lastDrillAccuracy: 0.9, reviewDueAt: '2026-11-05T00:00:00Z' }), now);
    expect(notDue.score).toBeLessThan(p.score / 2);
    expect(leakPriority(leak({ status: 'improving' }), now).score).toBeLessThan(p.score);
    expect(leakPriority(leak({ status: 'resolved' }), now).score).toBe(0);
  });
});

describe('drillItems', () => {
  it('maps solver push/fold leaks to the matching solver-verified quiz filter plus own hands', () => {
    const items = drillItems(leak({ leakKey: 'pf:sbShove:tooTight:6.5–10', evidence: 'solver', drill: 'gto:pushfold', examples: ['a'] }), true);
    expect(items.filter((i) => i.type === 'gto').every((i) => i.params?.role === 'sbShove' && i.params.range === '7-11')).toBe(true);
    expect(items[0]).toMatchObject({ type: 'replay', params: { decisionId: 'a' } });
  });
  it('never replays own hands when the user has none', () => {
    expect(drillItems(leak(), false).some((i) => i.type === 'replay')).toBe(false);
  });
});

describe('buildDailyPlan', () => {
  const base = { leaks: [leak(), leak({ leakKey: 'pf:bbCall:tooTight:≤6', evidence: 'solver', drill: 'gto:pushfold', severity: 0.8, confidence: 'high', examples: ['x'] }), leak({ leakKey: 'pattern:riverValue', drill: 'scenario:river', severity: 0.2 })], dueReviews: ['scenario', 'gto', 'math'] as const, newTypes: ['sim', 'scenario'] as const, hasRealHands: true, now, seed: 7 };
  it.each([5, 10, 20] as const)('fits a %s-minute budget and labels every item', (minutes) => {
    const p = buildDailyPlan({ ...base, minutes, dueReviews: [...base.dueReviews], newTypes: [...base.newTypes] });
    expect(p.estimatedSec).toBeLessThanOrEqual(minutes * 60 + Math.max(...Object.values(ITEM_SECONDS)));
    expect(p.items.length).toBeGreaterThan(0);
    expect(p.items.every((i) => ['leak', 'review', 'new'].includes(i.reason))).toBe(true);
    expect(p.focus.length).toBe(minutes === 5 ? 1 : minutes === 10 ? 2 : 3);
    // the top-priority leak (solver, severe, high confidence) leads the plan
    expect(p.focus[0]!.leakKey).toBe('pf:bbCall:tooTight:≤6');
    expect(p.items[0]!.leakKey).toBe('pf:bbCall:tooTight:≤6');
    // leaks take the largest share of time
    const leakSec = p.items.filter((i) => i.reason === 'leak').reduce((s, i) => s + ITEM_SECONDS[i.type], 0);
    expect(leakSec / p.estimatedSec).toBeGreaterThan(0.45);
    // no three of a kind in a row, unless only that type is left
    for (let i = 2; i < p.items.length; i++)
      if (p.items[i]!.type === p.items[i - 1]!.type && p.items[i]!.type === p.items[i - 2]!.type) expect(p.items.slice(i).every((x) => x.type === p.items[i]!.type)).toBe(true);
    // one own hand is replayed at most once
    const replays = p.items.filter((i) => i.params?.decisionId).map((i) => i.params!.decisionId);
    expect(new Set(replays).size).toBe(replays.length);
  });
  it('keeps variety: at most two focus leaks from the same drill family when others exist', () => {
    const pf = (k: string, sev: number) => leak({ leakKey: k, evidence: 'solver', drill: 'gto:pushfold', severity: sev, confidence: 'high' });
    const p = buildDailyPlan({ ...base, minutes: 20, leaks: [pf('pf:sbShove:tooTight:≤6', 0.9), pf('pf:bbCall:tooTight:≤6', 0.85), pf('pf:bbCall:tooTight:6.5–10', 0.8), leak({ severity: 0.3 })], dueReviews: [], newTypes: [] });
    expect(p.focus.map((f) => f.leakKey)).toEqual(['pf:sbShove:tooTight:≤6', 'pf:bbCall:tooTight:≤6', 'pattern:rfi:UTG']);
    const only = buildDailyPlan({ ...base, minutes: 20, leaks: [pf('pf:a:tooTight:≤6', 0.9), pf('pf:b:tooTight:≤6', 0.8), pf('pf:c:tooTight:≤6', 0.7)], dueReviews: [], newTypes: [] });
    expect(only.focus).toHaveLength(3);
  });
  it('is deterministic for a seed and works with no leaks', () => {
    const a = buildDailyPlan({ ...base, minutes: 10, dueReviews: [...base.dueReviews], newTypes: [...base.newTypes] });
    const b = buildDailyPlan({ ...base, minutes: 10, dueReviews: [...base.dueReviews], newTypes: [...base.newTypes] });
    expect(a).toEqual(b);
    const none = buildDailyPlan({ ...base, leaks: [], minutes: 10, dueReviews: ['gto'], newTypes: ['sim'] });
    expect(none.focus).toEqual([]);
    expect(none.items.length).toBeGreaterThan(0);
    expect(none.items.every((i) => i.reason !== 'leak')).toBe(true);
  });
});
