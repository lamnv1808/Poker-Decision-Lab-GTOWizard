import { describe, expect, it } from 'vitest';
import { parseCards } from '../src/cards';
import { decisionMath, pricesChosenAction, type DecisionMathResult, type MathFact } from '../src/dqe/decisionMath';
import { applyAction, computePots, createHand, dealNextStreet, legalActions, type HandState, type PlayerAction, type TableConfig } from '../src/engine';

const table = (stacks: number[], extra: Partial<TableConfig> = {}): TableConfig => ({ smallBlind: 50, bigBlind: 100, ante: 0, anteMode: 'none', players: stacks.map((s, i) => ({ id: `p${i}`, stack: s })), ...extra });
const act = (s: HandState, type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount?: number) => applyAction(s, { type, amount });
const fact = (m: DecisionMathResult, id: MathFact['id']) => m.facts.find((f) => f.id === id);
const no = (m: DecisionMathResult, id: MathFact['id']) => m.unsupported.find((u) => u.id === id);
const toAct = (s: HandState) => s.players[s.toAct]!.id;

/** heads-up flop: p0 (button/SB) and p1 (BB); preflop raise to 500 and call → pot 1,000 (10 BB) */
function huFlop(stacks = [10000, 10000]): HandState {
  let s = createHand(table(stacks));
  s = act(s, 'raise', 500);
  s = act(s, 'call');
  return dealNextStreet(s, parseCards('Ah7d2c'));
}

describe('decision maths — independent reference examples (hand-computed)', () => {
  it('half-pot bet heads-up: P = 15 BB, C = 5 BB → pot odds 3:1, required equity 25 %, MDF 2/3 (conditional)', () => {
    let s = huFlop();
    s = act(s, 'bet', 500);
    const m = decisionMath(s, toAct(s), { type: 'call' });
    expect(m.status).toBe('ok');
    expect(fact(m, 'potOdds')).toMatchObject({ value: 3, class: 'ARITHMETIC_IDENTITY', formulaId: 'pdl.math.potOdds.v1' });
    const req = fact(m, 'requiredEquity')!;
    expect(req).toMatchObject({ value: 0.25, formula: 'C / (P + C)', class: 'ARITHMETIC_IDENTITY', evidenceCategory: 'EXACT_MATHEMATICAL_RESULT' });
    // P includes the opponent's wager, excludes Hero's pending call
    expect(req.inputs).toEqual([{ name: 'P', value: 15, unit: 'BB' }, { name: 'C', value: 5, unit: 'BB' }]);
    const mdf = fact(m, 'minimumDefenceFrequency')!;
    expect(mdf.value).toBeCloseTo(2 / 3, 4);
    expect(mdf.class).toBe('CONDITIONAL_MODEL_REFERENCE');
    expect(mdf.assumptions.length).toBeGreaterThan(0);
    expect(mdf.applicability).toContain('heads-up');
  });

  it('pot-size bet: bet = 1.0 pot, risk/reward 1:1, break-even fold 50 % (conditional, zero-equity bluff)', () => {
    const s = huFlop();
    const m = decisionMath(s, toAct(s), { type: 'bet', amount: 1000 });
    expect(fact(m, 'betFractionOfPot')!.value).toBe(1);
    expect(fact(m, 'riskReward')!.value).toBe(1);
    expect(fact(m, 'breakEvenFoldFrequency')).toMatchObject({ value: 0.5, class: 'CONDITIONAL_MODEL_REFERENCE', formula: 'R / (P + R)' });
  });

  it('min-bet 1 BB and 5× overbet: break-even 1/11 and 5/6', () => {
    const s = huFlop();
    expect(fact(decisionMath(s, toAct(s), { type: 'bet', amount: 100 }), 'breakEvenFoldFrequency')!.value).toBeCloseTo(1 / 11, 4);
    expect(fact(decisionMath(s, toAct(s), { type: 'bet', amount: 5000 }), 'breakEvenFoldFrequency')!.value).toBeCloseTo(5 / 6, 4);
  });

  it('raise: Hero raises a 5 BB bet to 20 BB — R = 20 BB, P = 15 BB, break-even 20/35', () => {
    let s = huFlop();
    s = act(s, 'bet', 500);
    const m = decisionMath(s, toAct(s), { type: 'raise', amount: 2000 });
    expect(fact(m, 'riskReward')!.inputs).toEqual([{ name: 'R (at risk if called)', value: 20, unit: 'BB' }, { name: 'P (pot before Hero’s action)', value: 15, unit: 'BB' }]);
    expect(fact(m, 'breakEvenFoldFrequency')!.value).toBeCloseTo(20 / 35, 4);
    expect(fact(m, 'breakEvenFoldFrequency')!.assumptions.join(' ')).toMatch(/no re-raise/);
  });

  it('effective stack and SPR: 95 BB behind each, 10 BB pot → SPR 9.5 (descriptive)', () => {
    const s = huFlop();
    const m = decisionMath(s, toAct(s), { type: 'check' });
    expect(fact(m, 'effectiveStack')!.value).toBe(95);
    expect(fact(m, 'spr')).toMatchObject({ value: 9.5, class: 'ARITHMETIC_IDENTITY' });
    expect(fact(m, 'spr')!.caveats.join(' ')).toMatch(/does not say whether/);
  });
});

describe('decision maths — difficult cases', () => {
  it('a call that closes the river action: final threshold, no implied-odds caveat; earlier streets keep it', () => {
    let s = huFlop();
    s = act(s, 'check'); s = act(s, 'check');
    s = dealNextStreet(s, parseCards('Kc'));
    s = act(s, 'check'); s = act(s, 'check');
    s = dealNextStreet(s, parseCards('3s'));
    s = act(s, 'bet', 500);
    const river = fact(decisionMath(s, toAct(s), { type: 'call' }), 'requiredEquity')!;
    expect(river.value).toBe(0.25);
    expect(river.caveats.join(' ')).toMatch(/final break-even/);
    expect(river.caveats.join(' ')).not.toMatch(/implied/);
    let f = huFlop();
    f = act(f, 'bet', 500);
    expect(fact(decisionMath(f, toAct(f), { type: 'call' }), 'requiredEquity')!.caveats.join(' ')).toMatch(/implied/);
  });

  it('overbet larger than any opponent can call: capped; excess uncalled', () => {
    const s = huFlop([3000, 20000]); // BB (deep) acts first on the flop; button has 25 BB behind
    const m = decisionMath(s, toAct(s), { type: 'bet', amount: 10000 });
    expect(fact(m, 'uncalledExcess')!.value).toBe(75);
    expect(fact(m, 'breakEvenFoldFrequency')!.value).toBeCloseTo(2500 / 3500, 4);
  });

  it('closing all-in: all-in call threshold (identity); MDF unsupported because the bettor is all-in', () => {
    let s = huFlop();
    s = act(s, 'bet', 9500);
    const m = decisionMath(s, toAct(s), { type: 'call' });
    expect(fact(m, 'allInCallThreshold')!.value).toBeCloseTo(9500 / 20000, 4);
    expect(fact(m, 'requiredEquity')).toBeUndefined();
    expect(no(m, 'minimumDefenceFrequency')!.reason).toMatch(/all-in/);
  });

  it('short all-in (Hero all-in for less): P counts only what Hero can win; no MDF', () => {
    let s = huFlop([10000, 3000]);
    s = act(s, 'check');
    s = act(s, 'bet', 4000);
    const m = decisionMath(s, toAct(s), { type: 'call' });
    expect(m.context.heroAllInForLess).toBe(true);
    expect(fact(m, 'callAmount')!.value).toBe(25);
    expect(fact(m, 'allInCallThreshold')!.value).toBeCloseTo(2500 / 6000, 4);
    expect(no(m, 'minimumDefenceFrequency')!.reason).toMatch(/all-in for less/);
  });

  it('side pot: a short all-in plus a bigger bet — threshold uses only the pots Hero is eligible for', () => {
    // preflop 3-way: the short stack shoves 10 BB, the next player raises to 60 BB, Hero decides
    let s = createHand(table([20000, 20000, 1000]));
    s = act(s, 'raise', 1000);
    s = act(s, 'raise', 6000);
    const hero = toAct(s);
    const m = decisionMath(s, hero, { type: 'call' });
    const t = fact(m, 'allInCallThreshold') ?? fact(m, 'requiredEquity');
    const after = computePots(applyAction(s, { type: 'call' }));
    const winnable = after.filter((p) => p.eligible.includes(hero)).reduce((a, p) => a + p.amount, 0);
    const C = fact(m, 'callAmount')!.value * 100;
    expect(t!.value).toBeCloseTo(C / winnable, 4);
  });

  it('multiway: MDF and break-even fold frequency are UNSUPPORTED with a reason; identities remain', () => {
    let s = createHand(table([10000, 10000, 10000]));
    s = act(s, 'call');
    s = act(s, 'call');
    s = act(s, 'check');
    s = dealNextStreet(s, parseCards('Kd8s3h'));
    const m1 = decisionMath(s, toAct(s), { type: 'bet', amount: 200 });
    expect(fact(m1, 'riskReward')).toBeTruthy();
    expect(no(m1, 'breakEvenFoldFrequency')!.reason).toMatch(/multiway/);
    s = act(s, 'bet', 200);
    const m2 = decisionMath(s, toAct(s), { type: 'call' });
    expect(no(m2, 'minimumDefenceFrequency')!.reason).toMatch(/multiway/);
    expect(fact(m2, 'requiredEquity')!.caveats.join(' ')).toMatch(/Players behind/);
  });

  it('PKO / ICM: identities kept with a chip-only caveat; conditional references unsupported', () => {
    let s = huFlop();
    s = act(s, 'bet', 500);
    const m = decisionMath(s, toAct(s), { type: 'call' }, { economics: 'PKO' });
    expect(fact(m, 'requiredEquity')!.caveats.join(' ')).toMatch(/PKO.*bounty/);
    expect(no(m, 'minimumDefenceFrequency')!.reason).toMatch(/PKO/);
    const b = decisionMath(huFlop(), toAct(huFlop()), { type: 'bet', amount: 500 }, { economics: 'ICM' });
    expect(no(b, 'breakEvenFoldFrequency')!.reason).toMatch(/ICM/);
  });

  it('incomplete, malformed or impossible states are unsupported, never guessed', () => {
    const s = huFlop();
    expect(decisionMath({ ...s, players: s.players.map((p, i) => (i === 0 ? { ...p, stack: Number.NaN } : p)) }, toAct(s), { type: 'check' }).unsupportedReason).toMatch(/malformed/);
    expect(decisionMath(s, 'nobody', { type: 'check' }).status).toBe('unsupported');
    expect(decisionMath(s, s.players.find((p) => p.id !== toAct(s))!.id, { type: 'check' }).unsupportedReason).toMatch(/not Hero/);
    expect(decisionMath({ ...s, config: { ...s.config, bigBlind: 0 } }, toAct(s), { type: 'check' }).unsupportedReason).toMatch(/big blind/);
  });
});

describe('decision maths — never a grade', () => {
  it('every result: strategic verdict NOT_ESTABLISHED, gradeable false, no grade/EV fields', () => {
    let s = huFlop();
    s = act(s, 'bet', 700);
    for (const chosen of [{ type: 'fold' }, { type: 'call' }, { type: 'raise', amount: 2500 }] as PlayerAction[]) {
      const m = decisionMath(s, toAct(s), chosen);
      expect(m.strategicVerdict).toBe('NOT_ESTABLISHED');
      expect(m.gradeable).toBe(false);
      expect(JSON.stringify(m)).not.toMatch(/"grade"|evLoss|"mistake"|"blunder"/);
      for (const f of m.facts) expect(f.notAStrategy).toBe(true);
    }
  });
});

// ---------- randomized invariants over engine states
function rng(seed: number) {
  let x = seed >>> 0;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 2 ** 32; };
}
const DECK = parseCards('2c3c4c5c6c7c8c9cTcJcQcKcAc2d3d4d5d6d7d8d9dTdJdQdKdAd2h3h4h5h6h7h8h9hThJhQhKhAh2s3s4s5s6s7s8s9sTsJsQsKsAs');

describe('decision maths — randomized invariants (5,000+ decisions)', () => {
  it('thresholds are in (0,1), consistent with the engine pots, deterministic, and conditional facts only where they apply', () => {
    const R = rng(20261105);
    let checked = 0;
    for (let hand = 0; hand < 1000; hand++) {
      const n = 2 + Math.floor(R() * 5);
      const stacks = Array.from({ length: n }, () => 300 + Math.floor(R() * 20000));
      let s = createHand(table(stacks, { ante: R() < 0.5 ? 12 : 0, anteMode: R() < 0.5 ? 'each' : 'none' }));
      const deck = [...DECK].sort(() => R() - 0.5);
      let board = 0;
      for (let step = 0; step < 40; step++) {
        if (s.awaitingBoard) {
          if (board >= 5) break;
          const k = board === 0 ? 3 : 1;
          s = dealNextStreet(s, deck.slice(board, board + k));
          board += k;
          continue;
        }
        const l = legalActions(s);
        if (!l) break;
        const options: PlayerAction[] = [];
        if (l.canCheck) options.push({ type: 'check' });
        if (l.canFold && l.toCall > 0) options.push({ type: 'fold' }, { type: 'call' });
        if (l.canBet) options.push({ type: 'bet', amount: Math.round(l.minRaiseTo + R() * (l.maxRaiseTo - l.minRaiseTo)) });
        if (l.canRaise) options.push({ type: 'raise', amount: Math.round(l.minRaiseTo + R() * (l.maxRaiseTo - l.minRaiseTo)) });
        if (!options.length) break;
        const chosen = options[Math.floor(R() * options.length)]!;
        const m = decisionMath(s, l.playerId, chosen);
        expect(m.status).toBe('ok');
        expect(decisionMath(s, l.playerId, chosen)).toEqual(m); // deterministic
        expect(m.gradeable).toBe(false);
        for (const f of m.facts) {
          expect(Number.isFinite(f.value)).toBe(true);
          if (f.unit === 'fraction' && !(f.value > 0 && f.value < 1)) throw new Error(JSON.stringify({ f, ctx: m.context, l: { toCall: l.toCall, callAmount: l.callAmount }, chosen }));
          if (f.class === 'CONDITIONAL_MODEL_REFERENCE') {
            expect(m.context.multiway).toBe(false);
            expect(f.assumptions.length).toBeGreaterThan(0);
          }
        }
        const thr = fact(m, 'requiredEquity') ?? fact(m, 'allInCallThreshold');
        if (l.toCall > 0) {
          expect(thr).toBeTruthy();
          const pots = computePots(applyAction(s, { type: 'call' }));
          const win = pots.filter((p) => p.eligible.includes(l.playerId)).reduce((a, p) => a + p.amount, 0);
          expect(thr!.value).toBeCloseTo(l.callAmount / win, 3);
          expect(1 / (1 + fact(m, 'potOdds')!.value)).toBeCloseTo(thr!.value, 2);
        } else expect(thr).toBeUndefined();
        if (chosen.type === 'bet' || chosen.type === 'raise') expect(pricesChosenAction(m) || m.unsupported.some((u) => u.id === 'riskReward')).toBe(true);
        checked++;
        try { s = applyAction(s, chosen); } catch { break; }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });
});
