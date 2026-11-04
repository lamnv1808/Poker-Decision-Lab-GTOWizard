import { describe, expect, it } from 'vitest';
import { CLASSES, bountyDecisionValue, buyInFromTournamentName, pkoCallThreshold, solveNmaxPushFold, type PkoSpot } from '../src';

const spot = (o: Partial<PkoSpot> = {}): PkoSpot => ({ buyIn: 10, startingStackChips: 20000, bigBlindChips: 400, heroChips: 6000, opponentChips: [4000], stage: 'early', ...o });
const share = (f: ArrayLike<number>) => { let s = 0; for (let h = 0; h < CLASSES.length; h++) s += f[h]! * (CLASSES[h]!.length === 2 ? 6 : CLASSES[h]!.endsWith('s') ? 4 : 12); return s / 1326; };

describe('PKO model prototype (approximate; never verified)', () => {
  it('face value and decision value are different numbers', () => {
    const r = bountyDecisionValue(spot());
    if (r.status !== 'approximate') throw new Error('expected approximate');
    // face: 50 % of $10 = $5 starting bounty, ×1.5 mid
    expect(r.faceValueUsd.mid).toBe(7.5);
    // decision: $7.5 × (0.5 + 0.5×0.5) × (20,000 / $5) chips/$ ÷ 400 = 56.25 BB
    expect(r.decisionValueBB.mid).toBe(56.25);
    expect(r.decisionValueBB.low).toBeLessThan(r.decisionValueBB.mid);
    expect(r.decisionValueBB.mid).toBeLessThan(r.decisionValueBB.high);
    expect(r.unknowns).toContain('current bounty of each player');
  });

  it('a covered player cannot collect the bounty: decision value 0', () => {
    const r = bountyDecisionValue(spot({ heroChips: 3000, opponentChips: [4000] }));
    if (r.status !== 'approximate') throw new Error('expected approximate');
    expect(r.covers).toBe(false);
    expect(r.decisionValueBB).toEqual({ low: 0, mid: 0, high: 0 });
  });

  it('missing tournament information or a late stage is unsupported, not guessed', () => {
    expect(bountyDecisionValue(spot({ buyIn: null })).status).toBe('unsupported');
    expect(bountyDecisionValue(spot({ startingStackChips: null })).status).toBe('unsupported');
    expect(bountyDecisionValue(spot({ stage: 'late' }))).toMatchObject({ status: 'unsupported', reason: expect.stringMatching(/ICM/) });
    expect(bountyDecisionValue(spot({ opponentChips: [2000, 3000] }))).toMatchObject({ status: 'unsupported', reason: expect.stringMatching(/multiway/) });
  });

  it('call threshold: the bounty lowers the required equity; chip EV is reported separately and unchanged', () => {
    // facing a 10 BB shove with 10 BB behind: call 9 BB into 11.5 BB pot (after call: 20.5)
    const r = pkoCallThreshold(spot({ startingStackChips: 10000, buyIn: 10, bigBlindChips: 400 }), 9, 20.5);
    expect(r.chipEV).toBeCloseTo(9 / 20.5, 6);
    expect(r.pko!.high).toBeLessThan(r.pko!.mid);
    expect(r.pko!.mid).toBeLessThan(r.pko!.low);
    expect(r.pko!.low).toBeLessThan(r.chipEV);
  });

  it('parses the buy-in from tournament names, refusing ambiguous ones', () => {
    expect(buyInFromTournamentName('Speed Racer Bounty $5.40 ')).toBe(5.4);
    expect(buyInFromTournamentName('Bounty Hunters Sunday Special $15 ')).toBe(15);
    expect(buyInFromTournamentName('$8.88 Midnight Madness ')).toBe(8.88);
    expect(buyInFromTournamentName('Bounty Six Shooter')).toBeNull();
    expect(buyInFromTournamentName('$5 + $5 Special')).toBeNull();
  });

  it('push/fold with a bounty: bountyBB = 0 reproduces chip EV exactly; a bounty widens both shoving and calling', () => {
    const base = solveNmaxPushFold({ tableSize: 6, stackBB: 10, deadBB: 1 }, { iterations: 400 });
    const zero = solveNmaxPushFold({ tableSize: 6, stackBB: 10, deadBB: 1, bountyBB: 0 }, { iterations: 400 });
    expect(zero.shove).toEqual(base.shove);
    const pko = solveNmaxPushFold({ tableSize: 6, stackBB: 10, deadBB: 1, bountyBB: 5 }, { iterations: 400 });
    const sb = base.order.indexOf('SB');
    expect(share(pko.shove[sb]!)).toBeGreaterThan(share(base.shove[sb]!));
    // BB calling vs SB's shove
    const bbCallBase = base.call[sb]![base.order.indexOf('BB')]!;
    const bbCallPko = pko.call[sb]![pko.order.indexOf('BB')]!;
    expect(share(bbCallPko)).toBeGreaterThan(share(bbCallBase));
  });
});
