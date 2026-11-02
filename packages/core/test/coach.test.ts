import { describe, expect, it } from 'vitest';
import type { Card } from '../src/cards/cards';
import { type HandState, applyAction, createHand, dealNextStreet } from '../src/engine';
import { COMBOS, type SimConfig, assessReasoning, evaluateVsModel, explainModel } from '../src/sim';

const c = (s: string) => s.match(/../g) as Card[];
const BB = 100;
function river(sb: string, bb: string, board: string): HandState {
  let s = createHand({ smallBlind: 50, bigBlind: BB, ante: 0, anteMode: 'none', players: [{ id: 'SB', stack: 100 * BB, cards: c(sb) }, { id: 'BB', stack: 100 * BB, cards: c(bb) }] });
  const b = c(board);
  s = applyAction(s, { type: 'call' });
  s = applyAction(s, { type: 'check' });
  s = dealNextStreet(s, b.slice(0, 3));
  s = applyAction(s, { type: 'check' });
  s = applyAction(s, { type: 'check' });
  s = dealNextStreet(s, [b[3]!]);
  s = applyAction(s, { type: 'check' });
  s = applyAction(s, { type: 'check' });
  return dealNextStreet(s, [b[4]!]);
}
const all = () => new Float64Array(COMBOS.length).fill(1);
const cfgBB = (arch: SimConfig['villains'][string]): SimConfig => ({ tableSize: 2, heroPos: 'BB', stacksBB: { SB: 100, BB: 100 }, anteMode: 'none', villains: { SB: arch } });
const facts = (m: NonNullable<ReturnType<typeof evaluateVsModel>>, action: 'fold' | 'check' | 'call' | 'bet' | 'raise') => ({ street: 'river', action, toCallBB: m.facts.toCallBB, requiredEquity: m.facts.requiredEquity, equityVsRange: m.facts.equityVsRange, model: m });

describe('Tier 2 decisions and sizing (acceptance 6–9)', () => {
  it('value betting the nuts beats checking; the recommendation is the EV-maximising size and is explained', () => {
    const s = river('7c2d', 'AhKh', 'QhJhTh3c2s'); // Hero BB: royal flush
    const m = evaluateVsModel(s, cfgBB('station'), { SB: all() }, { type: 'check' })!;
    const best = m.options.find((o) => o.key === m.bestKey)!;
    expect(['bet', 'allin']).toContain(best.kind);
    expect(best.evBB).toBe(Math.max(...m.options.map((o) => o.evBB)));
    expect(m.chosenKey).toBe('check');
    expect(m.grade).not.toBe('excellent');
    const ex = explainModel(m);
    expect(ex.why.en).toMatch(/Value/);
    expect(ex.recommended.vi.length).toBeGreaterThan(0);
  });
  it('compares the overbet with smaller sizes and never claims a single size when several are within tolerance', () => {
    const s = river('7c2d', 'AhKh', 'QhJhTh3c2s');
    const m = evaluateVsModel(s, cfgBB('tag'), { SB: all() }, { type: 'bet', amount: 100 })!;
    const sizes = m.options.filter((o) => o.kind === 'bet' || o.kind === 'allin').map((o) => o.sizePctPot!);
    expect(sizes.some((x) => x >= 150)).toBe(true); // overbet evaluated
    expect(sizes.some((x) => x <= 50)).toBe(true); // small bet evaluated
    for (const k of m.goodKeys) expect(m.options.find((o) => o.key === m.bestKey)!.evBB - m.options.find((o) => o.key === k)!.evBB).toBeLessThanOrEqual(m.toleranceBB + 1e-9);
    const ex = explainModel(m);
    if (!m.goodKeys.includes(m.chosenKey)) expect(ex.sizing).not.toBeNull();
  });
  it('a pure bluff: the EV of betting comes only from folds, and checking with air never wins', () => {
    const s = river('AsAd', '7c2d', 'KhQh8s4c3d'); // Hero BB: 7-high, Villain range = everything
    const m = evaluateVsModel(s, cfgBB('nit'), { SB: all() }, { type: 'bet', amount: 150 })!;
    const bet = m.options.find((o) => o.isChosen)!;
    expect(bet.equityWhenCalled!).toBeLessThan(0.5);
    // the evaluation never invents value: a bluff's EV is bounded by what folds win
    expect(bet.evBB).toBeLessThanOrEqual(bet.reaction!.fold * m.facts.potBB + 1e-6);
  });
  it('check / trap vs a value bet: the recommendation follows the EVs, including after-check bets by the opponent', () => {
    const s = river('7c2d', 'AhKh', 'QhJhTh3c2s');
    for (const arch of ['nit', 'maniac'] as const) {
      const m = evaluateVsModel(s, cfgBB(arch), { SB: all() }, { type: 'check' })!;
      const chk = m.options.find((o) => o.kind === 'check')!;
      expect(chk.villainBets).toBeDefined();
      const r = assessReasoning(['trap'], facts(m, 'check'));
      const bestBet = Math.max(...m.options.filter((o) => o.kind !== 'check').map((o) => o.evBB));
      expect(r.checks[0]!.verdict).toBe(bestBet - chk.evBB <= m.toleranceBB ? 'supported' : 'contradicted');
    }
  });
});

describe('reasoning checks (acceptance 16–18)', () => {
  const s = river('AsAd', 'Kd5c', 'KhQh8s4c3d'); // Hero BB: top pair
  it('no reasoning: nothing to assess, the decision is still graded', () => {
    const m = evaluateVsModel(s, cfgBB('tag'), { SB: all() }, { type: 'check' })!;
    expect(assessReasoning([], facts(m, 'check')).quality).toBe('notAssessed');
    expect(m.grade).toBeDefined();
  });
  it('flawed reasoning is contradicted by the facts of the spot', () => {
    const m = evaluateVsModel(s, cfgBB('tag'), { SB: all() }, { type: 'check' })!;
    const r = assessReasoning(['protection', 'impliedOdds', 'potOdds', 'value'], facts(m, 'check'));
    expect(r.checks.map((x) => x.verdict)).toEqual(['contradicted', 'contradicted', 'contradicted', 'contradicted']);
    expect(r.quality).toBe('flawed');
    // calling a "bluff" a value bet: a bet that wins when called is not a bluff
    const nuts = evaluateVsModel(river('7c2d', 'AhKh', 'QhJhTh3c2s'), cfgBB('station'), { SB: all() }, { type: 'bet', amount: 150 })!;
    expect(assessReasoning(['bluff'], facts(nuts, 'bet')).checks[0]!.verdict).toBe('contradicted');
    expect(assessReasoning(['value'], facts(nuts, 'bet')).checks[0]!.verdict).toBe('supported');
  });
  it('correct reasoning on a bluff-catch: supported exactly when equity beats the price', () => {
    let st = river('AsAd', 'Kd5c', 'KhQh8s4c3d');
    st = applyAction(st, { type: 'check' });
    st = applyAction(st, { type: 'bet', amount: 150 });
    const cfg: SimConfig = { tableSize: 2, heroPos: 'BB', stacksBB: { SB: 100, BB: 100 }, anteMode: 'none', villains: { SB: 'maniac' } };
    const m = evaluateVsModel(st, cfg, { SB: all() }, { type: 'call' })!;
    const r = assessReasoning(['bluffCatch', 'villainTendency', 'position'], facts(m, 'call'));
    expect(r.checks[0]!.verdict).toBe(m.facts.equityVsRange >= m.facts.requiredEquity! ? 'supported' : 'contradicted');
    expect(r.checks[1]!.verdict).toBe('supported');
    expect(r.checks[2]!.verdict).toBe('notChecked');
  });
});
