import { describe, expect, it } from 'vitest';
import { applyAction, createHand, dealNextStreet, parseCards, topicsFor, contenders } from '../src';

const table = (stacks: number[]) => ({ smallBlind: 500, bigBlind: 1000, ante: 0, anteMode: 'none' as const, players: stacks.map((s, i) => ({ id: ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'][i]!, stack: s })) });

describe('curriculum topics (information available at the decision only)', () => {
  it('calling a shove vs initiating a shove', () => {
    let s = createHand(table([12000, 12000, 50000, 50000, 50000, 12000]));
    for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'fold' });
    expect(topicsFor(s, 'BTN', parseCards('Ah7c'), 'MTT')).toContain('initiatingShove');
    s = applyAction(s, { type: 'raise', amount: 12000 }); // BTN shoves
    expect(topicsFor(s, 'SB', parseCards('KdQd'), 'MTT')).toContain('callingShove');
  });
  it('preflop multiway counts voluntary entrants, not players yet to act or blinds', () => {
    let s = createHand(table([50000, 50000, 50000, 50000, 50000, 50000]));
    expect(contenders(s, 'UTG').map((p) => p.id)).toEqual(['UTG']);
    s = applyAction(s, { type: 'call' }); // UTG limps
    s = applyAction(s, { type: 'call' }); // HJ limps
    expect(contenders(s, 'CO').map((p) => p.id).sort()).toEqual(['CO', 'HJ', 'UTG']);
    expect(topicsFor(s, 'CO', parseCards('9s8s'), 'MTT')).toContain('multiwayOrBounty');
  });
  it('top pair facing a big bet, draws, value and bluff spots', () => {
    let s = createHand(table([50000, 50000]));
    s = applyAction(s, { type: 'call' });
    s = applyAction(s, { type: 'check' });
    s = dealNextStreet(s, parseCards('Kd7h2c'));
    s = applyAction(s, { type: 'bet', amount: 2000 }); // BB (first postflop heads-up) bets pot
    expect(topicsFor(s, 'SB', parseCards('KsQc'), 'MTT')).toContain('topPairVsAggression');
    expect(topicsFor(s, 'SB', parseCards('6h5h'), 'MTT')).not.toContain('topPairVsAggression');
    let d = createHand(table([50000, 50000]));
    d = applyAction(d, { type: 'call' });
    d = applyAction(d, { type: 'check' });
    d = dealNextStreet(d, parseCards('Kh7h2c'));
    d = applyAction(d, { type: 'check' });
    expect(topicsFor(d, 'SB', parseCards('Ah9h'), 'MTT')).toContain('drawsAndOuts');
    d = applyAction(d, { type: 'check' });
    d = dealNextStreet(d, parseCards('3s'));
    d = applyAction(d, { type: 'check' });
    d = applyAction(d, { type: 'check' });
    d = dealNextStreet(d, parseCards('4d'));
    d = applyAction(d, { type: 'check' });
    expect(topicsFor(d, 'SB', parseCards('KcJc'), 'MTT')).toContain('valueBetting');
    expect(topicsFor(d, 'SB', parseCards('QcJc'), 'MTT')).toContain('bluffing');
  });
  it('turn that changes the board', () => {
    let s = createHand(table([50000, 50000]));
    s = applyAction(s, { type: 'call' });
    s = applyAction(s, { type: 'check' });
    s = dealNextStreet(s, parseCards('Kh7h2c'));
    s = applyAction(s, { type: 'check' });
    s = applyAction(s, { type: 'check' });
    s = dealNextStreet(s, parseCards('9h')); // third heart
    expect(topicsFor(s, 'BB', parseCards('AsQd'), 'MTT')).toContain('turnChangesBoard');
  });
  it('topics never depend on future cards: same state, different later boards, same topics', () => {
    let s = createHand(table([50000, 50000]));
    s = applyAction(s, { type: 'call' });
    s = applyAction(s, { type: 'check' });
    const a = dealNextStreet(s, parseCards('Kd7h2c'));
    expect(topicsFor(a, 'BB', parseCards('AsQd'), 'MTT')).toEqual(topicsFor(structuredClone(a), 'BB', parseCards('AsQd'), 'MTT'));
  });
});
