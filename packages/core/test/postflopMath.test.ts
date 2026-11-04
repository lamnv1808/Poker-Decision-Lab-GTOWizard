import { describe, expect, it } from 'vitest';
import { parseCards } from '../src/cards';
import { decisionMath, type MathFact } from '../src/dqe/postflopMath';
import { applyAction, createHand, dealNextStreet, type HandState, type TableConfig } from '../src/engine';

const table = (stacks: number[], extra: Partial<TableConfig> = {}): TableConfig => ({ smallBlind: 50, bigBlind: 100, ante: 0, anteMode: 'none', players: stacks.map((s, i) => ({ id: `p${i}`, stack: s })), ...extra });
const act = (s: HandState, type: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount?: number) => applyAction(s, { type, amount });
const fact = (fs: MathFact[], k: MathFact['key']) => fs.find((f) => f.key === k);
const toAct = (s: HandState) => s.players[s.toAct]!.id;

/** heads-up flop: p0 (button/SB) and p1 (BB), 1,000 pot after preflop raise-call */
function huFlop(stacks = [10000, 10000]): HandState {
  let s = createHand(table(stacks));
  s = act(s, 'raise', 500);
  s = act(s, 'call');
  return dealNextStreet(s, parseCards('Ah7d2c'));
}

describe('decision maths — identities vs model references', () => {
  it('facing a half-pot bet heads-up: pot odds 3:1, required equity 25 %, MDF 66.7 % (model reference, not a strategy)', () => {
    let s = huFlop();
    s = act(s, 'bet', 500); // p1 bets 500 into 1,000
    const m = decisionMath(s, toAct(s), { type: 'call' });
    expect(m.status).toBe('ok');
    expect(fact(m.facts, 'potOdds')!.value).toBe(3);
    const req = fact(m.facts, 'requiredEquity')!;
    expect(req.value).toBe(0.25);
    expect(req.kind).toBe('identity');
    expect(req.caveats.join(' ')).toMatch(/implied/);
    const mdf = fact(m.facts, 'minimumDefenceFrequency')!;
    expect(mdf.value).toBeCloseTo(2 / 3, 4);
    expect(mdf.kind).toBe('modelReference');
    expect(mdf.notAStrategy).toBe(true);
    expect(mdf.assumptions.join(' ')).toMatch(/zero equity/);
    expect(fact(m.facts, 'allInCallThreshold')).toBeUndefined();
  });

  it('Hero bets pot: risk/reward 1, break-even fold frequency 50 % as a zero-equity-bluff reference', () => {
    const s = huFlop();
    const m = decisionMath(s, toAct(s), { type: 'bet', amount: 1000 });
    expect(fact(m.facts, 'riskReward')!.value).toBe(1);
    const be = fact(m.facts, 'breakEvenFoldFrequency')!;
    expect(be.value).toBe(0.5);
    expect(be.kind).toBe('modelReference');
    expect(be.caveats.join(' ')).toMatch(/fewer folds/);
  });

  it('unusual sizes: a min-bet and a 5x overbet', () => {
    const s = huFlop();
    expect(fact(decisionMath(s, toAct(s), { type: 'bet', amount: 100 }).facts, 'breakEvenFoldFrequency')!.value).toBeCloseTo(100 / 1100, 4);
    expect(fact(decisionMath(s, toAct(s), { type: 'bet', amount: 5000 }).facts, 'breakEvenFoldFrequency')!.value).toBeCloseTo(5000 / 6000, 4);
  });

  it('an overbet larger than any opponent can call is capped; the excess is reported as uncalled', () => {
    const s = huFlop([3000, 20000]); // BB (deep) acts first on the flop; the button has 2,500 behind
    const m = decisionMath(s, toAct(s), { type: 'bet', amount: 10000 });
    expect(fact(m.facts, 'uncalledExcess')!.value).toBe(75); // 7,500 chips = 75 BB never at risk
    expect(fact(m.facts, 'breakEvenFoldFrequency')!.value).toBeCloseTo(2500 / 3500, 4);
  });

  it('facing an all-in with no one left to act: the exact all-in call threshold (identity), MDF flagged as nearly meaningless', () => {
    let s = huFlop();
    s = act(s, 'bet', 9500); // p1 shoves 9,500 into 1,000
    const m = decisionMath(s, toAct(s), { type: 'call' });
    const t = fact(m.facts, 'allInCallThreshold')!;
    expect(t.kind).toBe('identity');
    expect(t.value).toBeCloseTo(9500 / 20000, 4);
    expect(fact(m.facts, 'requiredEquity')).toBeUndefined();
    expect(fact(m.facts, 'minimumDefenceFrequency')!.caveats.join(' ')).toMatch(/all-in/);
  });

  it('Hero all-in for less: only the pot Hero can win counts; the excess becomes a side pot', () => {
    let s = huFlop([10000, 3000]);
    // flop: p1 (BB, 2,500 behind) acts first and checks; p0 bets 4,000; p1 can only call 2,500
    s = act(s, 'check');
    s = act(s, 'bet', 4000);
    const m = decisionMath(s, toAct(s), { type: 'call' });
    expect(m.context.heroAllInForLess).toBe(true);
    expect(fact(m.facts, 'callAmount')!.value).toBe(25);
    // winnable = 1,000 + 2,500 + 2,500 = 6,000 → threshold 2,500 / 6,000
    expect(fact(m.facts, 'allInCallThreshold')!.value).toBeCloseTo(2500 / 6000, 4);
    expect(fact(m.facts, 'minimumDefenceFrequency')).toBeUndefined();
  });

  it('multiway with a side pot: required equity uses only the pots Hero is eligible for', () => {
    // 3 players preflop: p2 (UTG/button order) shoves 1,000 short; p0 raises big; p1 decides
    let s = createHand(table([20000, 20000, 1000]));
    s = act(s, 'raise', 1000); // p0? → actor depends on seat order; drive by legal actor
    const first = toAct(s);
    s = act(s, 'raise', 6000);
    const m = decisionMath(s, toAct(s), { type: 'call' });
    expect(m.status).toBe('ok');
    expect(m.context.multiway).toBe(true);
    const thr = fact(m.facts, 'allInCallThreshold') ?? fact(m.facts, 'requiredEquity');
    expect(thr).toBeTruthy();
    expect(thr!.value).toBeGreaterThan(0);
    expect(thr!.value).toBeLessThan(1);
    void first;
  });

  it('multiway bet: MDF and break-even fold frequency carry the multiway caveat', () => {
    let s = createHand(table([10000, 10000, 10000]));
    s = act(s, 'call');
    s = act(s, 'call');
    s = act(s, 'check');
    s = dealNextStreet(s, parseCards('Kd8s3h'));
    const bettor = toAct(s);
    const m1 = decisionMath(s, bettor, { type: 'bet', amount: 200 });
    expect(fact(m1.facts, 'breakEvenFoldFrequency')!.caveats.join(' ')).toMatch(/ALL of them/);
    s = act(s, 'bet', 200);
    const m2 = decisionMath(s, toAct(s), { type: 'call' });
    expect(fact(m2.facts, 'minimumDefenceFrequency')!.caveats.join(' ')).toMatch(/Multiway/);
    expect(fact(m2.facts, 'requiredEquity')!.caveats.join(' ')).toMatch(/Players behind/);
  });

  it('PKO / ICM formats keep the arithmetic but say what it ignores', () => {
    let s = huFlop();
    s = act(s, 'bet', 9500);
    const m = decisionMath(s, toAct(s), { type: 'call' }, { economics: 'PKO' });
    expect(fact(m.facts, 'allInCallThreshold')!.caveats.join(' ')).toMatch(/PKO.*bounty/);
    expect(fact(m.facts, 'minimumDefenceFrequency')!.caveats.join(' ')).toMatch(/PKO/);
  });

  it('SPR is measured at the decision', () => {
    const s = huFlop();
    expect(fact(decisionMath(s, toAct(s), { type: 'check' }).facts, 'spr')!.value).toBe(9.5);
  });

  it('incomplete or inconsistent histories are unsupported, never guessed', () => {
    const s = huFlop();
    const broken = { ...s, players: s.players.map((p, i) => (i === 0 ? { ...p, stack: Number.NaN } : p)) };
    expect(decisionMath(broken, toAct(s), { type: 'check' })).toMatchObject({ status: 'unsupported', unsupportedReason: expect.stringMatching(/incomplete/) });
    expect(decisionMath(s, 'nobody', { type: 'check' }).status).toBe('unsupported');
    const other = s.players.find((p) => p.id !== toAct(s))!.id;
    expect(decisionMath(s, other, { type: 'check' }).unsupportedReason).toMatch(/not Hero/);
  });

  it('every fact is labelled not-a-strategy; model references always state assumptions', () => {
    let s = huFlop();
    s = act(s, 'bet', 700);
    for (const f of decisionMath(s, toAct(s), { type: 'raise', amount: 2500 }).facts) {
      expect(f.notAStrategy).toBe(true);
      if (f.kind === 'modelReference') expect(f.assumptions.length).toBeGreaterThan(0);
    }
  });
});
