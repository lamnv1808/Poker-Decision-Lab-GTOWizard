import { describe, expect, it } from 'vitest';
import { ALL_SCENARIOS, CURRICULUM } from '../src/content';
import {
  Scenario,
  evaluateModel,
  gradeDecision,
  heroAct,
  matchOption,
  publicState,
  startScenario,
  validateScenario,
  type DecisionNode,
} from '../src/scenario';
import { legalActions, totalPot } from '../src/engine';

const byId = (id: string) => Scenario.parse(ALL_SCENARIOS.find((s) => s.id === id));

describe('content validation', () => {
  it('has 18 curriculum modules', () => {
    expect(CURRICULUM.map((m) => m.id)).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18']);
  });
  const ids = new Set<string>();
  for (const s of ALL_SCENARIOS) {
    it(`scenario ${s.id} validates`, () => {
      expect(ids.has(s.id)).toBe(false);
      ids.add(s.id);
      const r = validateScenario(s, { samples: 20000 });
      const errors = r.issues.filter((i) => i.level === 'error');
      expect(errors, JSON.stringify(errors, null, 1)).toEqual([]);
    });
  }
});

describe('runtime', () => {
  it('reaches the first decision with correct pot and stacks', () => {
    const s = byId('btn-ajs-35bb-open-flop-cbet');
    const c = startScenario(s);
    expect(c.nodeId).toBe('d-open');
    // BB ante 1000 + SB 500 + BB 1000 ; folds UTG, HJ, CO
    expect(totalPot(c.state)).toBe(2500);
    expect(c.state.players[c.state.toAct]!.id).toBe('BTN');
    const l = legalActions(c.state)!;
    expect(l.minRaiseTo).toBe(2000);
    expect(l.maxRaiseTo).toBe(35000);
  });
  it('follows a branch through flop and turn', () => {
    const s = byId('btn-ajs-35bb-open-flop-cbet');
    let c = startScenario(s);
    let step = heroAct(s, c, { type: 'raise', amount: 2200 });
    expect(step.option?.id).toBe('open-small');
    c = step.cursor;
    expect(c.nodeId).toBe('d-flop');
    expect(c.state.board).toEqual(['Ks', '7d', '3s']);
    // BTN 2200 + BB 2200 + SB 500 + ante 1000
    expect(totalPot(c.state)).toBe(5900);
    step = heroAct(s, c, { type: 'bet', amount: 1800 });
    expect(step.option?.id).toBe('bet-small');
    c = step.cursor;
    expect(c.nodeId).toBe('d-turn');
    expect(c.state.board).toHaveLength(4);
    expect(totalPot(c.state)).toBe(9500);
  });
  it('maps an off-tree size to no option and terminates honestly', () => {
    const s = byId('btn-ajs-35bb-open-flop-cbet');
    const c = startScenario(s);
    // remove the huge-raise option to simulate an uncovered sizing
    const node = structuredClone(s.nodes['d-open']) as DecisionNode;
    node.options = node.options.filter((o) => o.id !== 'open-huge');
    expect(matchOption(s, node, c.state, { type: 'raise', amount: 10000 })).toBeNull();
    const g = gradeDecision(s, node, null, null);
    expect(g.graded).toBe(false);
    expect(g.note).toBe('offTree');
  });
  it('rubric grading on heuristic content is never rating-eligible', () => {
    const s = byId('btn-ajs-35bb-open-flop-cbet');
    const node = s.nodes['d-open'] as DecisionNode;
    const g = gradeDecision(s, node, node.options.find((o) => o.id === 'shove')!, null);
    expect(g.grade).toBe('mistake');
    expect(g.basis).toBe('rubric');
    expect(g.ratingEligible).toBe(false);
    expect(g.evLoss).toBeUndefined();
  });
  it('hides villain cards in public state', () => {
    const s = byId('btn-ajs-35bb-open-flop-cbet');
    const c = startScenario(s);
    const pub = publicState(c.state, 'BTN');
    expect(pub.players.find((p) => p.id === 'BTN')!.cards).toEqual(['As', 'Js']);
    expect(pub.players.filter((p) => p.cards).length).toBe(1);
  });
});

describe('math models', () => {
  it('shove model: EV(fold)=0 and EV(shove) is consistent with manual formula', () => {
    const s = byId('sb-q9o-10bb-shove-vs-bb');
    const c = startScenario(s);
    const node = s.nodes[c.nodeId] as DecisionNode;
    const m = evaluateModel(s, node, c.state, { samples: 40000 })!;
    const fold = m.outcomes.find((o) => o.key === 'fold')!;
    const shove = m.outcomes.find((o) => o.key === 'shove')!;
    expect(fold.ev).toBe(0);
    // manual: pot before = SB .5 + BB 1 + ante 1 = 2.5BB. Fold -> win 2.5BB.
    // called: final pot = 10 + 10 + 1 = 21BB, hero risk 9.5 more.
    const p = shove.continueProb!;
    const eq = Number(shove.detail['BB.equityPct']) / 100;
    const manual = (1 - p) * 2.5 + p * (eq * 21 - 9.5);
    expect(shove.ev).toBeCloseTo(manual, 1);
    expect(shove.ev).toBeGreaterThan(0);
  });
  it('call model and EV grading are consistent', () => {
    const s = byId('bb-k9o-call-sb-shove-12bb');
    const c = startScenario(s);
    const node = s.nodes[c.nodeId] as DecisionNode;
    const m = evaluateModel(s, node, c.state, { samples: 40000 })!;
    const call = m.outcomes.find((o) => o.key === 'call')!;
    // pot before call = 12 + 1 + 1 = 14BB, call 11BB, final 25BB
    const eq = call.equity!.equity;
    expect(call.ev).toBeCloseTo(eq * 25 - 11, 6);
    expect(Number(call.detail.requiredPct)).toBeCloseTo((11 / 25) * 100, 6);
    const best = call.ev > 0 ? 'call' : 'fold';
    const worst = best === 'call' ? 'fold' : 'call';
    const gBest = gradeDecision(s, node, node.options.find((o) => o.id === best)!, m);
    const gWorst = gradeDecision(s, node, node.options.find((o) => o.id === worst)!, m);
    expect(gBest.grade).toBe('excellent');
    expect(gBest.ratingEligible).toBe(true);
    expect(gWorst.evLoss).toBeCloseTo(Math.abs(call.ev), 6);
  });
});
