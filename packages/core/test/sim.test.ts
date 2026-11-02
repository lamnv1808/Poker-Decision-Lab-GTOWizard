import { describe, expect, it } from 'vitest';
import {
  type PlayerAction,
  type SimConfig,
  ARCHETYPES,
  COMBOS,
  IllegalActionError,
  PREFLOP_TOP_SHARE,
  dealSim,
  legalActions,
  policy,
  publicState,
  randomSimConfig,
  runSim,
  simReview,
} from '../src';

/** Plays a whole hand with a simple Hero strategy (check/call, never folds). */
function playOut(seed: number, cfg: SimConfig, pick: (legal: NonNullable<ReturnType<typeof legalActions>>) => PlayerAction = (l) => (l.canCheck ? { type: 'check' } : { type: 'call' })) {
  const actions: PlayerAction[] = [];
  let run = runSim(seed, cfg, actions, { equitySamples: 200 });
  for (let i = 0; i < 30 && run.awaitingHero; i++) {
    actions.push(pick(legalActions(run.state)!));
    run = runSim(seed, cfg, actions, { equitySamples: 200 });
  }
  return { run, actions };
}

const hu = (stackBB: number, heroPos: 'SB' | 'BB', villain: (typeof ARCHETYPES)[number] = 'tag', anteMode: 'none' | 'bigBlind' = 'none'): SimConfig => ({
  tableSize: 2,
  heroPos,
  stacksBB: { SB: stackBB, BB: stackBB },
  anteMode,
  villains: { [heroPos === 'SB' ? 'BB' : 'SB']: villain },
});

describe('full-hand simulator', () => {
  it('is deterministic for a seed and Hero actions', () => {
    const cfg = randomSimConfig(7);
    const a = playOut(42, cfg);
    const b = playOut(42, cfg);
    expect(b.run.state.history).toEqual(a.run.state.history);
    expect(b.run.villainEvents).toEqual(a.run.villainEvents);
  });

  it('plays every hand to a terminal state and conserves chips', () => {
    for (let seed = 1; seed <= 120; seed++) {
      const cfg = randomSimConfig(seed);
      const { run } = playOut(seed, cfg);
      expect(run.state.complete).toBe(true);
      const net = simReview(run).net;
      expect(Math.abs(Object.values(net).reduce((s, x) => s + x, 0))).toBeLessThan(1e-6);
      const start = Object.values(cfg.stacksBB).reduce((s, x) => s + x, 0) * 100;
      expect(run.state.players.reduce((s, p) => s + p.stack, 0)).toBe(start);
    }
  });

  it('never exposes undealt board cards or Villain hole cards while Hero is deciding', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const cfg = randomSimConfig(seed);
      const deal = dealSim(seed, cfg);
      const actions: PlayerAction[] = [];
      let run = runSim(seed, cfg, actions, { equitySamples: 100 });
      while (run.awaitingHero) {
        const view = publicState(run.state, cfg.heroPos);
        const n = { preflop: 0, flop: 3, turn: 4, river: 5 }[view.street];
        expect(view.board).toEqual(deal.board.slice(0, n));
        const json = JSON.stringify(view);
        for (const c of deal.board.slice(n)) expect(json).not.toContain(`"${c}"`);
        for (const p of view.players) if (p.id !== cfg.heroPos) expect(p.cards).toBeUndefined();
        const l = legalActions(run.state)!;
        actions.push(l.canCheck ? { type: 'check' } : { type: 'call' });
        run = runSim(seed, cfg, actions, { equitySamples: 100 });
      }
    }
  });

  it('rejects illegal Hero actions', () => {
    const cfg = hu(50, 'BB');
    let seed = 1;
    let run = runSim(seed, cfg, []);
    while (!run.awaitingHero || legalActions(run.state)!.canCheck) run = runSim(++seed, cfg, []);
    expect(() => runSim(seed, cfg, [{ type: 'check' }])).toThrow(IllegalActionError);
  });

  it('archetypes differ: a calling station plays far more hands than a nit', () => {
    const ctx = { street: 'preflop' as const, toCall: 100, raises: 0, requiredEq: 0, nOpp: 5, canCheck: false, canRaise: true };
    const share = (a: (typeof ARCHETYPES)[number]) => COMBOS.reduce((s, _, i) => s + 1 - policy(a, ctx, PREFLOP_TOP_SHARE[i]!).fold, 0) / COMBOS.length;
    expect(share('nit')).toBeLessThan(0.16);
    expect(share('station')).toBeGreaterThan(0.4);
    expect(share('maniac')).toBeGreaterThan(share('tag'));
  });

  it('the Villain model range always contains the Villain’s real hand', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const cfg = randomSimConfig(seed);
      const { run } = playOut(seed, cfg);
      for (const [id, w] of Object.entries(run.ranges)) {
        const p = run.state.players.find((x) => x.id === id)!;
        if (p.folded) continue;
        const i = COMBOS.findIndex(([a, b]) => (a === p.cards![0] && b === p.cards![1]) || (a === p.cards![1] && b === p.cards![0]));
        expect(w[i]).toBeGreaterThan(0);
      }
    }
  });

  it('uses solver frequencies for a Villain in an exact push/fold spot (shove or fold only)', () => {
    let used = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const run = runSim(seed, hu(10, 'BB'), [], { equitySamples: 100 });
      const ev = run.villainEvents[0]!;
      expect(ev.source).toBe('solver');
      const sbAct = run.state.history.find((h) => h.playerId === 'SB' && h.type !== 'postSB')!;
      expect(sbAct.type === 'fold' || sbAct.allIn).toBe(true);
      used++;
    }
    expect(used).toBe(40);
  });

  it('grades Hero against the push/fold equilibrium (strategy track) and labels it', () => {
    let seed = 1;
    let run = runSim(seed, hu(10, 'SB'), []);
    // find a deal with a premium hand
    while (!['AA', 'KK', 'QQ', 'AKs', 'AKo'].includes(run.decisions[0]!.info.solver?.heroClass ?? '')) run = runSim(++seed, hu(10, 'SB'), []);
    const folded = runSim(seed, hu(10, 'SB'), [{ type: 'fold' }]);
    const fb = folded.decisions[0]!.feedback!;
    expect(fb.basis).toBe('solverEv');
    expect(fb.track).toBe('strategy');
    expect(['mistake', 'major']).toContain(fb.grade);
    const minRaise = runSim(seed, hu(10, 'SB'), [{ type: 'raise', amount: 200 }]);
    expect(minRaise.decisions[0]!.feedback!.graded).toBe(false);
  });

  it('only claims a model EV when the call ends the betting; otherwise ungraded', () => {
    let terminal = 0;
    let open = 0;
    for (let seed = 1; seed <= 200 && (terminal < 3 || open < 3); seed++) {
      const cfg = randomSimConfig(seed, { tableSize: 2, stackBB: 100 });
      const { run } = playOut(seed, cfg);
      for (const d of run.decisions) {
        if (d.action?.type !== 'call' || !d.feedback || d.info.solver) continue;
        if (d.feedback.graded) {
          terminal++;
          expect(d.feedback.basis).toBe('modelEv');
          // heads-up terminal calls are now Tier 2 (every action compared, recorded but never rated)
          expect(d.feedback.tier).toBe('model');
          expect(['fundamentals', 'model']).toContain(d.feedback.track);
          if (d.feedback.track === 'model') expect(d.feedback.model!.options.length).toBeGreaterThanOrEqual(2);
          expect(d.info.street === 'river' || d.info.toCallBB > 0).toBe(true);
        } else open++;
      }
    }
    expect(terminal).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(0);
  });
});

describe('Villain model versions', () => {
  it('sim-v1.1 respects bets by archetype (Nit folds most, Station least); sim-v1 hands rebuild unchanged', () => {
    const ctx = { street: 'flop' as const, toCall: 100, raises: 1, requiredEq: 0.28, nOpp: 1, canCheck: false, canRaise: true };
    const fold = (a: Parameters<typeof policy>[0], v?: string) => policy(a, ctx, 0.5, v).fold;
    expect(fold('nit')).toBeGreaterThan(fold('tag'));
    expect(fold('tag')).toBeGreaterThan(fold('lag'));
    expect(fold('lag')).toBeGreaterThan(fold('station'));
    // the stored version decides: v1 ignores the new term, so old hands replay exactly as dealt
    expect(fold('nit', 'sim-v1')).toBeLessThan(fold('nit', 'sim-v1.1'));
  });
});

describe('equity cache (performance)', () => {
  it('rebuilding with cached equities gives identical decisions and feedback', () => {
    const cfg = randomSimConfig(99, { tableSize: 6 });
    const acts: PlayerAction[] = [];
    let run = runSim(5, cfg, acts);
    for (let i = 0; i < 8 && run.awaitingHero; i++) {
      const l = legalActions(run.state)!;
      acts.push(l.canCheck ? { type: 'check' } : { type: 'call' });
      run = runSim(5, cfg, acts);
    }
    const cache = Object.fromEntries(run.decisions.map((d, i) => [i, d.info.modelEquity]));
    const fast = runSim(5, cfg, acts, { equityCache: cache, skipPendingEquity: true });
    expect(fast.state.history).toEqual(run.state.history);
    expect(fast.decisions.map((d) => d.feedback)).toEqual(run.decisions.map((d) => d.feedback));
  });
});
