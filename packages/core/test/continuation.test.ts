import { describe, expect, it } from 'vitest';
import { ALL_SCENARIOS, Scenario, answerQuestion, createRng, heroAct, legalActions, runSim, scenarioContinuation, simHiddenInfo, simReview, startScenario, type PlayerAction, type RunCursor } from '../src';

/** Play a curated scenario with the first legal non-fold action until its tree ends. */
function playScenario(sc: Scenario): RunCursor {
  let c = startScenario(sc);
  for (let i = 0; i < 10 && !c.terminated; i++) {
    const node = sc.nodes[c.nodeId]!;
    if (node.kind === 'question') c = answerQuestion(sc, c);
    else if (node.kind === 'decision') {
      const l = legalActions(c.state)!;
      const a: PlayerAction = l.canCheck ? { type: 'check' } : { type: 'call' };
      c = heroAct(sc, c, a).cursor;
    } else break;
  }
  return c;
}

describe('continuing curated scenarios as full hands', () => {
  const heroScenarios = ALL_SCENARIOS.map((s) => Scenario.parse(s)).filter((s) => s.mode === 'hero');

  it('every Hero scenario that ends mid-hand continues to a valid terminal state', () => {
    let continued = 0;
    for (const sc of heroScenarios) {
      const end = playScenario(sc);
      if (end.state.complete) continue;
      const rng = createRng(sc.id.length * 7919);
      const { config, deal, prefix } = scenarioContinuation(sc, end.state, (n) => Math.floor(rng() * n));
      // the scripted prefix reproduces the scenario's state exactly
      const start = runSim(1, config, [], { deal, prefix, equitySamples: 100 });
      const ours = start.state.history.filter((h) => !h.type.startsWith('post'));
      const theirs = end.state.history.filter((h) => !h.type.startsWith('post'));
      expect(ours.slice(0, theirs.length).map((h) => [h.playerId, h.type, h.amount])).toEqual(theirs.map((h) => [h.playerId, h.type, h.amount]));
      expect(start.state.board.slice(0, end.state.board.length)).toEqual(end.state.board);
      // authored board cards are kept; Hero's cards are the scenario's
      expect(deal.holes[sc.table.heroPos]!.join('')).toBe(sc.table.heroCards);
      // play on: check/call to the end
      const acts: PlayerAction[] = [];
      let run = start;
      for (let i = 0; i < 20 && run.awaitingHero; i++) {
        const l = legalActions(run.state)!;
        acts.push(l.canCheck ? { type: 'check' } : { type: 'call' });
        run = runSim(1, config, acts, { deal, prefix, equitySamples: 100 });
      }
      expect(run.state.complete).toBe(true);
      const startChips = run.state.players.reduce((s, p) => s + p.startingStack, 0);
      expect(run.state.players.reduce((s, p) => s + p.stack, 0)).toBe(startChips);
      const rv = simReview(run);
      expect(Math.abs(Object.values(rv.net).reduce((a, b) => a + b, 0))).toBeLessThan(0.05); // per-player rounding to 0.01 BB
      // hidden info is available after the hand and never alters the result
      const hidden = simHiddenInfo(run);
      expect(hidden.runout.length).toBe(5 - run.state.board.length);
      continued++;
    }
    expect(continued).toBeGreaterThan(15);
  });
});
