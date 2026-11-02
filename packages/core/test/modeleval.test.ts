import { describe, expect, it } from 'vitest';
import type { Card } from '../src/cards/cards';
import { createRng } from '../src/cards/rng';
import { type HandState, type PlayerAction, applyAction, createHand, dealNextStreet, legalActions } from '../src/engine';
import { COMBOS, type SimConfig, comboIndex, evaluateVsModel, sizeAggressive, villainModel } from '../src/sim';
import { classEquity } from '../src/gto';

/**
 * Tier 2 model evaluation — checked against (1) hand-calculated EVs and (2) an independent
 * simulation that plays every option out with the real engine (which pays the pots itself) and the
 * model's sampled reactions.
 */
const c = (s: string) => s.match(/../g) as Card[];
const BB = 100;

function riverSpot(o: { sb: string; bb: string; board: string; stacks?: number; antes?: boolean }): HandState {
  let s = createHand({ smallBlind: 50, bigBlind: BB, ante: o.antes ? 100 : 0, anteMode: o.antes ? 'bigBlind' : 'none', players: [{ id: 'SB', stack: (o.stacks ?? 100) * BB, cards: c(o.sb) }, { id: 'BB', stack: (o.stacks ?? 100) * BB, cards: c(o.bb) }] });
  const b = c(o.board);
  s = applyAction(s, { type: 'call' });
  s = applyAction(s, { type: 'check' });
  for (const street of [b.slice(0, 3), [b[3]!], [b[4]!]]) {
    s = dealNextStreet(s, street);
    if (street.length === 1 && s.board.length === 5) break;
    s = applyAction(s, { type: 'check' });
    s = applyAction(s, { type: 'check' });
  }
  return s;
}

const rangeOf = (entries: [string, number][]) => {
  const w = new Float64Array(COMBOS.length);
  for (const [cards, x] of entries) {
    const [a, b] = c(cards);
    w[comboIndex(a!, b!)] = x;
  }
  return w;
};

describe('Tier 2 model evaluation — hand-calculated', () => {
  it('a river call vs a known range: EV = P(win)·(pot + bet + call) − call', () => {
    // BB (Villain) bets 2 BB into 2 BB; Hero SB has top pair. Villain range: 77 (set, weight 1), QJ air (weight 3)
    let s = riverSpot({ sb: 'AsKd', bb: 'QcJc', board: 'Ah7c2d9s4h' });
    s = applyAction(s, { type: 'bet', amount: 200 });
    const cfg: SimConfig = { tableSize: 2, heroPos: 'SB', stacksBB: { SB: 100, BB: 100 }, anteMode: 'none', villains: { BB: 'tag' } };
    const e = evaluateVsModel(s, cfg, { BB: rangeOf([['7h7d', 1], ['QcJc', 3]]) }, { type: 'call' })!;
    expect(e.scope).toBe('riverHeadsUp');
    expect(e.equityMethod).toBe('exact');
    const call = e.options.find((o) => o.key === 'call')!;
    expect(call.evBB).toBeCloseTo((0.75 * 600 - 200) / BB, 6); // 2.5 BB
    expect(e.options.find((o) => o.key === 'fold')!.evBB).toBe(0);
    expect(e.facts.requiredEquity).toBeCloseTo(200 / 600, 3);
    expect(e.facts.equityVsRange).toBeCloseTo(0.75, 6);
    // the best option is at least as good as calling; the evaluation names Hero's choice
    expect(e.options.find((o) => o.key === e.bestKey)!.evBB).toBeGreaterThanOrEqual(call.evBB);
    expect(e.chosenKey).toBe('call');
  });

  it('a chop counts half: Hero and Villain both play the board', () => {
    let s = riverSpot({ sb: '2c3d', bb: '4s5s', board: 'AhKhQhJhTh' });
    s = applyAction(s, { type: 'bet', amount: 100 });
    const cfg: SimConfig = { tableSize: 2, heroPos: 'SB', stacksBB: { SB: 100, BB: 100 }, anteMode: 'none', villains: { BB: 'tag' } };
    const e = evaluateVsModel(s, cfg, { BB: rangeOf([['4s5s', 1]]) }, { type: 'fold' })!;
    // pot 2 BB + bet 1 BB + call 1 BB, Hero gets half back: 0.5·4 − 1 = +1 BB
    expect(e.options.find((o) => o.key === 'call')!.evBB).toBeCloseTo(1, 6);
    expect(e.bestKey).not.toBe('fold');
    expect(e.grade).not.toBe('excellent');
  });

  it('a preflop all-in call uses the class table and the pot formula', () => {
    let s = createHand({ smallBlind: 50, bigBlind: BB, ante: 0, anteMode: 'none', players: [{ id: 'SB', stack: 20 * BB, cards: c('AhKh') }, { id: 'BB', stack: 20 * BB, cards: c('QsQd') }] });
    s = applyAction(s, { type: 'raise', amount: 20 * BB }); // SB shoves 20 BB
    const cfg: SimConfig = { tableSize: 2, heroPos: 'BB', stacksBB: { SB: 20, BB: 20 }, anteMode: 'none', villains: { SB: 'lag' } };
    // Hero BB with QQ vs a range of exactly AKs combos (all four suits; one conflicts with nothing here)
    s.players[1]!.cards = c('QsQd');
    const e = evaluateVsModel(s, cfg, { SB: rangeOf([['AhKh', 1], ['AcKc', 1], ['AdKd', 1], ['AsKs', 1]]) }, { type: 'call' })!;
    expect(e.scope).toBe('allInCall');
    expect(e.equityMethod).toBe('classTable');
    expect(e.confidence).toBe('medium');
    const eq = classEquity('QQ', 'AKs');
    // call 19 BB to win a 40 BB pot
    expect(e.options.find((o) => o.key === 'call')!.evBB).toBeCloseTo(eq * 40 - 19, 3);
  });

  it('returns null (Tier 3) where later Hero decisions would have to be modelled', () => {
    let s = createHand({ smallBlind: 50, bigBlind: BB, ante: 0, anteMode: 'none', players: [{ id: 'SB', stack: 100 * BB, cards: c('AhKh') }, { id: 'BB', stack: 100 * BB, cards: c('QsQd') }] });
    s = applyAction(s, { type: 'call' });
    s = applyAction(s, { type: 'check' });
    s = dealNextStreet(s, c('2c7d9h'));
    const cfg: SimConfig = { tableSize: 2, heroPos: 'BB', stacksBB: { SB: 100, BB: 100 }, anteMode: 'none', villains: { SB: 'tag' } };
    expect(evaluateVsModel(s, cfg, { SB: new Float64Array(COMBOS.length).fill(1) }, { type: 'check' })).toBeNull();
  });
});

describe('Tier 2 model evaluation — independent simulation with the real engine', () => {
  /** Play one option to the end: sample a Villain combo and its model reaction; the engine pays out. */
  function simulate(s0: HandState, cfg: SimConfig, w: Float64Array, make: PlayerAction, reply: 'call' | 'fold' | undefined, n: number, seed: number) {
    const rng = createRng(seed);
    const hero = s0.players[s0.toAct]!.id;
    const vid = s0.players.find((p) => p.id !== hero)!.id;
    const dead = new Set([...s0.players.find((p) => p.id === hero)!.cards!, ...s0.board]);
    const idx: number[] = [];
    const cum: number[] = [];
    let t = 0;
    for (let i = 0; i < w.length; i++) if (w[i]! > 0 && !dead.has(COMBOS[i]![0]) && !dead.has(COMBOS[i]![1])) {
      t += w[i]!;
      idx.push(i);
      cum.push(t);
    }
    const start = s0.players.find((p) => p.id === hero)!.stack;
    let sum = 0;
    let sq = 0;
    for (let k = 0; k < n; k++) {
      const x = rng() * t;
      const ci = idx[cum.findIndex((v) => v > x)]!;
      let s = structuredClone(s0);
      s.players.find((p) => p.id === vid)!.cards = [...COMBOS[ci]!];
      s = applyAction(s, make);
      while (!s.complete) {
        const l = legalActions(s)!;
        const actor = s.players[s.toAct]!;
        if (actor.id === vid) {
          const pr = villainModel(s, cfg).probsFor(ci);
          const u = rng();
          const cat = u < pr.fold ? 'fold' : u < pr.fold + pr.passive ? 'passive' : 'aggressive';
          if (cat === 'fold' && !l.canCheck) s = applyAction(s, { type: 'fold' });
          else if (cat === 'aggressive' && (l.canBet || l.canRaise)) {
            // same deterministic sizing rule the model uses
            s = applyAction(s, sizeAggressive(s, l, cfg.villains[vid]!, false));
          } else s = applyAction(s, l.canCheck ? { type: 'check' } : { type: 'call' });
        } else s = applyAction(s, reply === 'fold' ? { type: 'fold' } : { type: 'call' });
      }
      const end = s.players.find((p) => p.id === hero)!.stack;
      const v = (end - start) / BB;
      sum += v;
      sq += v * v;
    }
    const mean = sum / n;
    return { mean, se: Math.sqrt(Math.max(0, sq / n - mean * mean) / n) };
  }

  it('every option of a river spot (check, bet sizes, all-in) matches the simulated EV', () => {
    const s = riverSpot({ sb: 'Td9d', bb: 'KhJs', board: 'Kc8h4d2s7c' }); // Hero BB: top pair, OOP, first to act
    const cfg: SimConfig = { tableSize: 2, heroPos: 'BB', stacksBB: { SB: 100, BB: 100 }, anteMode: 'none', villains: { SB: 'tag' } };
    const w = new Float64Array(COMBOS.length).fill(1);
    const e = evaluateVsModel(s, cfg, { SB: w }, { type: 'bet', amount: 150 })!;
    expect(e.options.map((o) => o.key)).toContain('check');
    expect(e.options.filter((o) => o.kind === 'bet' || o.kind === 'allin').length).toBeGreaterThanOrEqual(4);
    for (const o of e.options) {
      const sim = simulate(s, cfg, w, o.make, o.replyToAggression, 6000, 1234 + o.key.length);
      expect(Math.abs(sim.mean - o.evBB)).toBeLessThan(4 * sim.se + 0.02);
    }
  });

  it('facing a river bet: fold, call and raises match the simulation (with antes in the pot)', () => {
    let s = riverSpot({ sb: 'QhQs', bb: 'Ac5c', board: 'Jd8s3c2h9d', antes: true });
    s = applyAction(s, { type: 'bet', amount: 250 }); // BB bets into Hero SB
    const cfg: SimConfig = { tableSize: 2, heroPos: 'SB', stacksBB: { SB: 100, BB: 100 }, anteMode: 'bigBlind', anteBB: 1, villains: { BB: 'lag' } };
    const w = new Float64Array(COMBOS.length).fill(1);
    const e = evaluateVsModel(s, cfg, { BB: w }, { type: 'call' })!;
    for (const o of e.options) {
      const sim = simulate(s, cfg, w, o.make, o.replyToAggression, 6000, 99 + o.key.length);
      expect(Math.abs(sim.mean - o.evBB)).toBeLessThan(4 * sim.se + 0.02);
    }
  });
});
