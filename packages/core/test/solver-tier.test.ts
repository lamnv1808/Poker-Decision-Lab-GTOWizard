import { describe, expect, it } from 'vitest';
import { type PlayerAction, type SimConfig, DEFAULT_THRESHOLDS, classIndex, gradeFromEvLoss, legalActions, randomSimConfig, runSim, solvePushFold } from '../src';

/**
 * Phase 1 acceptance: the Solver tier. A simulated decision may only be labelled "solver" when it is an
 * exact heads-up push/fold subgame (2–15 BB, half-BB grid, dead money on the audited grid) or a node of
 * the solved flop library. Everything else must stay "model" or "limited".
 */
const hu = (stackBB: number, heroPos: 'SB' | 'BB', anteMode: 'none' | 'bigBlind' = 'none'): SimConfig => ({
  tableSize: 2,
  heroPos,
  stacksBB: { SB: stackBB, BB: stackBB },
  anteMode,
  villains: { [heroPos === 'SB' ? 'BB' : 'SB']: 'tag' },
});
const shove = (run: ReturnType<typeof runSim>): PlayerAction => ({ type: 'raise', amount: legalActions(run.state)!.maxRaiseTo });
const r3 = (x: number) => Math.round(x * 1000) / 1000;

describe('Solver tier — heads-up push/fold (SB to act)', () => {
  for (const stackBB of [5, 8, 10, 12, 15]) {
    it(`${stackBB} BB: table state, legal actions, EVs and labels match the push/fold equilibrium`, () => {
      const sol = solvePushFold({ stackBB, deadBB: 0 });
      for (let seed = 1; seed <= 25; seed++) {
        const cfg = hu(stackBB, 'SB');
        const first = runSim(seed, cfg, []);
        const info = first.decisions[0]!.info;
        // position, pot and stack accounting
        expect(info.street).toBe('preflop');
        expect(info.potBB).toBeCloseTo(1.5, 9);
        expect(info.toCallBB).toBeCloseTo(0.5, 9);
        expect(info.requiredEquity).toBeCloseTo(0.5 / 2, 3); // call 0.5 into 1.5 + 0.5
        const legal = legalActions(first.state)!;
        expect(legal.canFold).toBe(true);
        expect(legal.maxRaiseTo / first.state.config.bigBlind).toBeCloseTo(stackBB, 9); // all-in = whole stack
        // the spot is recognised exactly
        expect(info.solver).not.toBeNull();
        expect(info.solver!.role).toBe('sbShove');
        expect(info.solver!.stackBB).toBe(stackBB);
        expect(info.solver!.deadBB).toBe(0);
        const ci = classIndex(info.solver!.heroClass);
        expect(info.solver!.frequency).toBe(sol.push[ci]);
        expect(info.solver!.evAggressiveBB).toBe(r3(sol.evShove[ci]!));

        for (const [name, act] of [['shove', shove(first)], ['fold', { type: 'fold' } as PlayerAction]] as const) {
          const fb = runSim(seed, cfg, [act]).decisions[0]!.feedback!;
          expect(fb.tier).toBe('solver');
          expect(fb.assessment).toBe('solverVerified');
          expect(fb.basis).toBe('solverEv');
          expect(fb.track).toBe('strategy');
          expect(fb.evByAction).toEqual({ shove: r3(sol.evShove[ci]!), fold: 0 });
          const evChosen = name === 'shove' ? sol.evShove[ci]! : 0;
          const mixed = sol.push[ci]! > 0 && sol.push[ci]! < 1;
          const loss = mixed ? 0 : Math.max(0, sol.evShove[ci]!, 0) - evChosen;
          expect(fb.evLossBB).toBeCloseTo(Math.max(0, loss), 3);
          // recommended label: shove when it is +EV, fold when it is −EV, "mixed" inside the mix
          expect(fb.best).toBe(mixed ? 'mixed' : sol.evShove[ci]! > 0 ? 'shove' : 'fold');
          expect(fb.explain?.recommended.en).toBeTruthy();
          expect(fb.note.en).toMatch(/push\/fold equilibrium/);
          expect(fb.grade).toBe(mixed ? 'excellent' : gradeFromEvLoss(Math.max(0, loss), DEFAULT_THRESHOLDS.bb));
        }
      }
    });
  }

  it('a limp or a small raise is outside the push/fold model: never labelled solver', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const limp = runSim(seed, hu(10, 'SB'), [{ type: 'call' }]).decisions[0]!.feedback!;
      expect(limp.tier).not.toBe('solver');
      expect(limp.graded).toBe(false);
      const small = runSim(seed, hu(10, 'SB'), [{ type: 'raise', amount: 200 }]).decisions[0]!.feedback!;
      expect(small.tier).not.toBe('solver');
      expect(small.graded).toBe(false);
    }
  });

  it('antes on the audited grid stay solver-verified; the dead money enters the pot', () => {
    let seen = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const run = runSim(seed, hu(10, 'SB', 'bigBlind'), []);
      const s = run.decisions[0]!.info.solver;
      if (!s) continue;
      seen++;
      expect(s.deadBB).toBeGreaterThan(0);
      expect(run.decisions[0]!.info.potBB).toBeCloseTo(1.5 + s.deadBB, 9);
      const fb = runSim(seed, hu(10, 'SB', 'bigBlind'), [shove(run)]).decisions[0]!.feedback!;
      expect(fb.tier).toBe('solver');
      // the ante comes out of the stack: the subgame is solved at the effective stack
      expect(s.stackBB).toBeLessThanOrEqual(10);
      const sol = solvePushFold({ stackBB: s.stackBB, deadBB: s.deadBB });
      expect(fb.evByAction!.shove).toBe(r3(sol.evShove[classIndex(s.heroClass)]!));
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('Solver tier — BB facing an all-in', () => {
  it('calling or folding an SB shove is graded against the equilibrium call range', () => {
    let graded = 0;
    for (let seed = 1; seed <= 200 && graded < 10; seed++) {
      const cfg = hu(10, 'BB');
      const run = runSim(seed, cfg, []);
      if (!run.awaitingHero) continue; // Villain folded
      const info = run.decisions[0]!.info;
      if (!info.solver) continue;
      expect(info.solver.role).toBe('bbCall');
      const sol = solvePushFold({ stackBB: 10, deadBB: 0 });
      const ci = classIndex(info.solver.heroClass);
      for (const act of [{ type: 'call' }, { type: 'fold' }] as PlayerAction[]) {
        const fb = runSim(seed, cfg, [act]).decisions[0]!.feedback!;
        expect(fb.tier).toBe('solver');
        expect(fb.evByAction).toEqual({ call: r3(sol.evCall[ci]!), fold: 0 });
      }
      graded++;
    }
    expect(graded).toBe(10);
  });
});

describe('Solver tier is never claimed outside exact spots', () => {
  it('16 BB (outside the solved grid) is not solver-graded', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const run = runSim(seed, hu(16, 'SB'), []);
      expect(run.decisions[0]!.info.solver).toBeNull();
      const fb = runSim(seed, hu(16, 'SB'), [shove(run)]).decisions[0]!.feedback!;
      expect(fb.tier).not.toBe('solver');
      expect(fb.assessment).not.toBe('solverVerified');
    }
  });

  it('random deep-stacked tables: every solver label comes from an exact push/fold spot or the solved flop library', () => {
    let decisions = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const cfg = randomSimConfig(seed, { tableSize: 2 + (seed % 5), stackBB: seed % 3 === 0 ? 10 : 40 });
      const actions: PlayerAction[] = [];
      let run = runSim(seed, cfg, actions, { equitySamples: 100 });
      for (let i = 0; i < 20 && run.awaitingHero; i++) {
        const l = legalActions(run.state)!;
        actions.push(l.canCheck ? { type: 'check' } : { type: 'call' });
        run = runSim(seed, cfg, actions, { equitySamples: 100 });
      }
      for (const d of run.decisions) {
        if (!d.feedback) continue;
        decisions++;
        if (d.feedback.tier === 'solver') expect(d.info.solver ?? d.oracle).toBeTruthy();
        if (d.feedback.tier !== 'solver') expect(d.feedback.assessment).not.toBe('solverVerified');
        if (d.feedback.tier === 'model') expect(d.feedback.basis).toBe('modelEv');
        if (d.feedback.basis === 'modelEv') expect(d.feedback.tier).not.toBe('solver');
      }
    }
    expect(decisions).toBeGreaterThan(200);
  });
});
