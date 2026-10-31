import { describe, expect, it } from 'vitest';
import {
  bluffBreakEven,
  bubbleFactor,
  evBet,
  evCall,
  hitProbability,
  icmEquities,
  icmWithBusts,
  impliedOddsNeeded,
  indifferentBluffShare,
  mdf,
  potOddsRatio,
  requiredEquity,
  ruleOf2And4,
  spr,
  valuePerBluff,
  bountyChipValue,
} from '../src/math';

describe('pot odds & thresholds', () => {
  it('required equity uses pot including villain bet', () => {
    // pot 100, villain bets 50 -> pot before call 150, call 50 -> 50/200
    expect(requiredEquity(50, 150)).toBe(0.25);
    expect(potOddsRatio(50, 150)).toBe(3);
    expect(requiredEquity(0, 100)).toBe(0);
  });
  it('bluff break-even fold frequency', () => {
    expect(bluffBreakEven(75, 100)).toBeCloseTo(75 / 175, 12);
    expect(bluffBreakEven(100, 100)).toBe(0.5);
  });
  it('MDF', () => {
    expect(mdf(100, 50)).toBeCloseTo(2 / 3, 12);
    expect(mdf(100, 100)).toBe(0.5);
    expect(mdf(100, 200)).toBeCloseTo(1 / 3, 12);
  });
  it('river polarized ratios', () => {
    // pot-sized bet: bluffs = 1/3 of betting range, value:bluff = 2:1
    expect(indifferentBluffShare(100, 100)).toBeCloseTo(1 / 3, 12);
    expect(valuePerBluff(100, 100)).toBe(2);
    expect(indifferentBluffShare(100, 50)).toBe(0.25);
  });
  it('indifference: calling a bet with the indifferent bluff share has EV 0 for a bluff-catcher', () => {
    const pot = 100;
    const bet = 60;
    const b = indifferentBluffShare(pot, bet);
    expect(evCall(b, pot + bet, bet)).toBeCloseTo(0, 10);
  });
  it('rejects invalid inputs', () => {
    expect(() => mdf(-1, 10)).toThrow();
    expect(() => requiredEquity(NaN, 1)).toThrow();
    expect(() => spr(10, 0)).toThrow();
  });
});

describe('EV formulas', () => {
  it('call EV', () => {
    expect(evCall(0.25, 150, 50)).toBeCloseTo(0, 12);
    expect(evCall(0.5, 150, 50)).toBe(50);
  });
  it('bet EV with zero-equity bluff at break-even is 0', () => {
    const f = bluffBreakEven(50, 100);
    expect(evBet(f, 100, 50, 0)).toBeCloseTo(0, 10);
    expect(evBet(1, 100, 50)).toBe(100);
  });
  it('SPR', () => {
    expect(spr(900, 300)).toBe(3);
  });
});

describe('outs', () => {
  it('exact hit probabilities', () => {
    expect(hitProbability(9, 47, 2)).toBeCloseTo(1 - (38 * 37) / (47 * 46), 12);
    expect(hitProbability(9, 46, 1)).toBeCloseTo(9 / 46, 12);
    expect(ruleOf2And4(9, 2)).toBeCloseTo(0.36, 12);
  });
  it('implied odds needed', () => {
    // pot 100 incl bet, call 50, equity 0.2 -> need 50/0.2 - 150 = 100 more
    expect(impliedOddsNeeded(0.2, 100, 50)).toBeCloseTo(100, 10);
    expect(impliedOddsNeeded(0.5, 100, 50)).toBe(0);
  });
});

describe('ICM', () => {
  it('equal stacks get equal equity and conserve the prize pool', () => {
    const eq = icmEquities([1000, 1000, 1000], [50, 30, 20]);
    for (const e of eq) expect(e).toBeCloseTo(100 / 3, 10);
  });
  it('matches a hand-computed 3-player example', () => {
    // stacks 50/30/20, payouts 70/30
    const eq = icmEquities([50, 30, 20], [70, 30]);
    // P1 first = .5; P1 second = .3*(50/70)+.2*(50/80)
    const p1 = 0.5 * 70 + (0.3 * (50 / 70) + 0.2 * (50 / 80)) * 30;
    expect(eq[0]).toBeCloseTo(p1, 10);
    expect(eq.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 10);
  });
  it('heads-up ICM is proportional to chips', () => {
    const eq = icmEquities([3000, 1000], [100, 50]);
    expect(eq[0]).toBeCloseTo(50 + 0.75 * 50, 10);
  });
  it('busted players take the lowest places', () => {
    const eq = icmWithBusts([0, 600, 400], [50, 30, 20]);
    expect(eq[0]).toBe(20);
    expect(eq[1]! + eq[2]!).toBeCloseTo(80, 10);
  });
  it('bubble factor exceeds 1 on a bubble', () => {
    expect(bubbleFactor([5000, 5000, 5000, 1000], [50, 30, 20], 0, 1)).toBeGreaterThan(1);
  });
  it('bounty chip value model', () => {
    expect(bountyChipValue(10, 1_000_000, 20_000)).toBe(500);
    expect(() => bountyChipValue(10, 0, 1)).toThrow();
  });
});
