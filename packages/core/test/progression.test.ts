import { describe, expect, it } from 'vitest';
import { type ActionProbs, type PlayerAction, type SimConfig, computePots, legalActions, runSim, simHiddenInfo, simReview } from '../src';

const HU: SimConfig = { tableSize: 2, heroPos: 'SB', stacksBB: { SB: 100, BB: 100 }, anteMode: 'none', villains: { BB: 'tag' } };
type Ov = Record<number, keyof ActionProbs>;

/** Run with Hero actions chosen by `pick`, forcing Villain choices in order via `forced`. */
function play(cfg: SimConfig, seed: number, pick: (l: NonNullable<ReturnType<typeof legalActions>>, street: string, n: number) => PlayerAction, forced: (keyof ActionProbs)[]) {
  const ov: Ov = {};
  const acts: PlayerAction[] = [];
  let run = runSim(seed, cfg, acts, { equitySamples: 100, villainOverrides: ov });
  for (let guard = 0; guard < 60; guard++) {
    // force the next modelled Villain decision that has not been forced yet
    const pending = run.villainEvents.filter((e) => !(e.historyIndex in ov) && e.source !== 'scripted');
    if (pending.length && Object.keys(ov).length < forced.length) {
      ov[pending[0]!.historyIndex] = forced[Object.keys(ov).length]!;
      run = runSim(seed, cfg, acts, { equitySamples: 100, villainOverrides: ov });
      continue;
    }
    if (!run.awaitingHero) break;
    acts.push(pick(legalActions(run.state)!, run.state.street, acts.length));
    run = runSim(seed, cfg, acts, { equitySamples: 100, villainOverrides: ov });
  }
  return run;
}
const raiseOrBet = (l: NonNullable<ReturnType<typeof legalActions>>): PlayerAction => (l.canBet ? { type: 'bet', amount: l.minRaiseTo } : l.canRaise ? { type: 'raise', amount: l.minRaiseTo } : l.canCheck ? { type: 'check' } : { type: 'call' });
const passive = (l: NonNullable<ReturnType<typeof legalActions>>): PlayerAction => (l.canCheck ? { type: 'check' } : { type: 'call' });
const conserve = (run: ReturnType<typeof runSim>) => expect(run.state.players.reduce((s, p) => s + p.stack, 0)).toBe(run.state.players.reduce((s, p) => s + p.startingStack, 0));
const heroStreets = (run: ReturnType<typeof runSim>) => run.decisions.filter((d) => d.action).map((d) => d.info.street);

describe('full-hand progression (a correct action never ends the hand by itself)', () => {
  it('preflop raise → Villain calls → the hand continues to a flop decision', () => {
    const run = play(HU, 11, (l, st) => (st === 'preflop' ? raiseOrBet(l) : passive(l)), ['passive', 'passive', 'passive', 'passive']);
    expect(heroStreets(run)).toContain('flop');
    expect(run.state.complete).toBe(true);
    conserve(run);
  });
  it('flop bet → Villain calls → advances to the turn; turn bet-call → river; river call → showdown', () => {
    const run = play(HU, 12, (l) => raiseOrBet(l), ['passive', 'passive', 'passive', 'passive', 'passive', 'passive']);
    expect(heroStreets(run)).toEqual(expect.arrayContaining(['preflop', 'flop', 'turn', 'river']));
    expect(run.state.board).toHaveLength(5);
    expect(run.state.result!.showdown).toBe(true);
    const rv = simReview(run);
    expect(rv.showdown.length).toBe(2);
    expect(rv.winners.length).toBeGreaterThan(0);
    expect(rv.showdown.every((x) => x.category)).toBe(true);
    conserve(run);
  });
  it('flop bet → Villain raises → Hero must decide again on the flop', () => {
    // Hero in the BB acts first postflop: SB limps (forced), Hero checks, Hero bets the flop, SB raises (forced)
    const bbHero: SimConfig = { ...HU, heroPos: 'BB', villains: { SB: 'tag' } };
    let flopBets = 0;
    const run = play(bbHero, 13, (l, st) => (st === 'flop' && flopBets++ === 0 ? raiseOrBet(l) : passive(l)), ['passive', 'aggressive']);
    const flop = run.decisions.filter((d) => d.info.street === 'flop' && d.action);
    expect(flop.length).toBeGreaterThanOrEqual(2);
    expect(flop[1]!.info.toCallBB).toBeGreaterThan(0);
  });
  it('Hero fold and Villain fold both end the hand immediately (no invented streets)', () => {
    const heroFold = play(HU, 14, (l) => (l.canFold ? { type: 'fold' } : passive(l)), []);
    expect(heroFold.state.complete).toBe(true);
    expect(heroFold.state.result!.showdown).toBe(false);
    const villFold = play(HU, 15, (l) => raiseOrBet(l), ['fold']);
    expect(villFold.state.complete).toBe(true);
    expect(villFold.state.board.length).toBe(0);
    expect(simReview(villFold).endedBy).toBe('fold');
    conserve(villFold);
  });
  it('an all-in and call runs out the whole board to showdown', () => {
    const run = play(HU, 16, (l) => (l.canRaise || l.canBet ? { type: l.canBet ? 'bet' : 'raise', amount: l.maxRaiseTo } : passive(l)), ['passive']);
    expect(run.state.board).toHaveLength(5);
    expect(run.state.result!.showdown).toBe(true);
    conserve(run);
  });
  it('side pots with three different stacks stay correct and chips are conserved', () => {
    const cfg: SimConfig = { tableSize: 3, heroPos: 'BTN', stacksBB: { SB: 10, BB: 30, BTN: 60 }, anteMode: 'none', villains: { SB: 'maniac', BB: 'maniac' } };
    const run = play(cfg, 17, (l) => (l.canRaise ? { type: 'raise', amount: l.maxRaiseTo } : passive(l)), ['passive', 'passive']);
    expect(run.state.complete).toBe(true);
    expect(computePots(run.state).length).toBeGreaterThanOrEqual(2);
    conserve(run);
  });
  it('revealing hidden cards and the runout after a fold never changes the result', () => {
    const run = play(HU, 18, (l) => (l.canFold ? { type: 'fold' } : passive(l)), []);
    const before = JSON.stringify(run.state.result);
    const hidden = simHiddenInfo(run);
    expect(hidden.runout).toHaveLength(5 - run.state.board.length);
    expect(hidden.opponents[0]!.cards).toHaveLength(2);
    expect(JSON.stringify(run.state.result)).toBe(before);
    expect(() => simHiddenInfo(runSim(18, HU, [], { equitySamples: 50 }))).toThrow();
  });
});
