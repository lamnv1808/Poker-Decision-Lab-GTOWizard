import { type Card, parseCards } from '../cards/cards';
import { equityVsRange, type EquityResult } from '../cards/equity';
import { type Range, comboCount, parseRange, removeBlocked } from '../cards/range';
import { hashString } from '../cards/rng';
import { type HandState, applyAction, computePots, legalActions } from '../engine';
import { icmWithBusts } from '../math/icm';
import type { DecisionNode, Scenario } from './schema';

/**
 * Math models that compute action EVs for a decision under EXPLICIT assumptions
 * (stated Villain ranges; no future betting). Results are exact given the assumptions
 * (river/postflop enumeration) or seeded Monte Carlo with a reported standard error (preflop).
 */

export interface ModelOutcome {
  key: string;
  /** EV in the node's unit, relative to the model's baseline (folding = 0 for chip EV). */
  ev: number;
  /** Probability Villain(s) continue (call), when meaningful. */
  continueProb?: number;
  equity?: EquityResult;
  detail: Record<string, number | string>;
}

export interface ModelResult {
  unit: 'bb' | 'icmPct';
  outcomes: ModelOutcome[];
  assumptions: string[];
  /** Largest standard error (in the EV unit) introduced by sampling, 0 when exact. */
  evStdErr: number;
}

/** Monte Carlo samples for preflop model equities. */
export const DEFAULT_SAMPLES = 150000;

const ANY_TWO = '22+,A2+,K2+,Q2+,J2+,T2+,92+,82+,72+,62+,52+,42+,32';

function intersect(a: Range, b: Range): Range {
  const out: Range = new Map();
  for (const [k, w] of a) {
    const v = b.get(k);
    if (v) out.set(k, w * v);
  }
  return out;
}

function heroCards(s: Scenario): Card[] {
  return parseCards(s.table.heroCards);
}

/** Fold everyone (except `keep`) who is to act until the betting round closes or `stopAt` acts. */
function foldAround(state: HandState, stopAt: string | null): HandState {
  let s = state;
  let guard = 0;
  while (!s.complete && !s.awaitingBoard && s.toAct >= 0 && s.players[s.toAct]!.id !== stopAt) {
    const l = legalActions(s)!;
    s = applyAction(s, l.canFold ? { type: 'fold' } : { type: 'check' });
    if (++guard > 20) throw new Error('foldAround loop');
  }
  return s;
}

/** Final stacks (by player id) when `winner` wins every pot they are eligible for vs the other live player. */
function stacksAfter(state: HandState, outcome: 'win' | 'lose' | 'tie', heroIdStr: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of state.players) out[p.id] = p.stack;
  if (state.complete && state.result && !state.result.showdown) {
    // already awarded by fold
    return out;
  }
  const pots = computePots(state);
  for (const pot of pots) {
    const heroIn = pot.eligible.includes(heroIdStr);
    const others = pot.eligible.filter((id) => id !== heroIdStr);
    if (!heroIn) {
      const share = pot.amount / others.length;
      for (const id of others) out[id]! += share;
      continue;
    }
    if (others.length === 0 || outcome === 'win') out[heroIdStr]! += pot.amount;
    else if (outcome === 'lose') for (const id of others) out[id]! += pot.amount / others.length;
    else {
      out[heroIdStr]! += pot.amount / 2;
      for (const id of others) out[id]! += pot.amount / 2 / others.length;
    }
  }
  return out;
}

/** Add a PKO bounty (chip-equivalent) to Hero's stack in a branch where `villainId` busted. */
function withBounty(stacks: Record<string, number>, heroIdStr: string, villainId: string, bountyChips: number): Record<string, number> {
  if (bountyChips <= 0 || stacks[villainId]! > 0) return stacks;
  return { ...stacks, [heroIdStr]: stacks[heroIdStr]! + bountyChips };
}

interface Branch {
  prob: number;
  stacks: Record<string, number>;
}

function valueOf(branches: Branch[], scenario: Scenario, unit: 'bb' | 'icmPct', heroIdStr: string, baseStacks: Record<string, number>, order: string[]): number {
  if (unit === 'bb') {
    const base = baseStacks[heroIdStr]!;
    return branches.reduce((s, b) => s + b.prob * (b.stacks[heroIdStr]! - base), 0) / scenario.table.bigBlind;
  }
  const payouts = scenario.tournament?.payouts;
  if (!payouts) throw new Error('ICM unit requires tournament.payouts');
  const others = (scenario.tournament?.otherStacksBB ?? []).map((x) => x * scenario.table.bigBlind);
  const total = payouts.reduce((a, b) => a + b, 0);
  const heroIdx = order.indexOf(heroIdStr);
  return branches.reduce((s, b) => {
    const stacks = [...order.map((id) => b.stacks[id]!), ...others];
    return s + (b.prob * icmWithBusts(stacks, payouts)[heroIdx]! * 100) / total;
  }, 0);
}

/**
 * Compute model EVs for a decision node at the given state.
 * chip EV baseline: Hero's stack if Hero folds now (so fold = 0).
 * ICM: absolute expected prize share (% of prize pool) for every option.
 */
export function evaluateModel(scenario: Scenario, node: DecisionNode, state: HandState, opts: { samples?: number } = {}): ModelResult | null {
  const model = node.model;
  if (!model) return null;
  const hero = scenario.table.heroPos;
  const unit = node.evUnit;
  const order = state.players.map((p) => p.id);
  const cards = heroCards(scenario);
  const board = state.board;
  const dead = [...cards, ...board];
  const seed = hashString(`${scenario.id}:${scenario.version}`);
  const baseStacks: Record<string, number> = Object.fromEntries(state.players.map((p) => [p.id, p.stack]));
  const legal = legalActions(state);
  if (!legal || state.players[state.toAct]!.id !== hero) throw new Error('Model evaluated when Hero is not to act');
  const assumptions: string[] = [];
  const outcomes: ModelOutcome[] = [];
  let evStdErr = 0;

  // Fold branch (shared): Hero folds, remaining players resolve by folding to the last player.
  const foldOutcome = (): ModelOutcome => {
    if (!legal.canFold) throw new Error('Model includes fold but folding is not legal');
    const s = foldAround(applyAction(state, { type: 'fold' }), null);
    const stacks = s.complete ? Object.fromEntries(s.players.map((p) => [p.id, p.stack])) : stacksAfter(s, 'lose', hero);
    return { key: 'fold', ev: valueOf([{ prob: 1, stacks }], scenario, unit, hero, baseStacks, order), detail: {} };
  };

  if (model.type === 'shove') {
    const shoveTo = legal.maxRaiseTo;
    const shoved = applyAction(state, { type: legal.canBet ? 'bet' : 'raise', amount: shoveTo });
    let remaining = 1;
    const branches: Branch[] = [];
    let s = shoved;
    const perCaller: Record<string, number | string> = {};
    for (const c of model.callers) {
      s = foldAround(s, c.pos);
      if (s.players[s.toAct]?.id !== c.pos) throw new Error(`Caller ${c.pos} is not due to act after Hero's shove`);
      const holding = removeBlocked(parseRange(c.holdingRange ?? ANY_TWO), dead);
      const calls = intersect(holding, parseRange(c.callRange));
      const p = comboCount(calls) / comboCount(holding);
      const prob = remaining * p;
      if (p > 0) {
        const eq = equityVsRange(cards, calls, board, { samples: opts.samples ?? DEFAULT_SAMPLES, seed: seed ^ hashString(c.pos) });
        const called = foldAround(applyAction(s, { type: 'call' }), null);
        if (c.bountyBB && unit !== 'bb') throw new Error('Bounty models are ChipEV only');
        const win = withBounty(stacksAfter(called, 'win', hero), hero, c.pos, (c.bountyBB ?? 0) * scenario.table.bigBlind);
        const lose = stacksAfter(called, 'lose', hero);
        const tie = stacksAfter(called, 'tie', hero);
        branches.push({ prob: prob * eq.win, stacks: win }, { prob: prob * eq.lose, stacks: lose }, { prob: prob * eq.tie, stacks: tie });
        // sampling error on equity propagates linearly into EV: d(EV)/d(eq) = pot swing
        const swing = (win[hero]! - lose[hero]!) / (unit === 'bb' ? scenario.table.bigBlind : 1);
        if (unit === 'bb') evStdErr = Math.max(evStdErr, prob * eq.stdErr * swing);
        perCaller[`${c.pos}.callPct`] = Math.round(p * 1000) / 10;
        perCaller[`${c.pos}.equityPct`] = Math.round(eq.equity * 1000) / 10;
      }
      remaining *= 1 - p;
      s = applyAction(s, { type: 'fold' });
    }
    s = foldAround(s, null);
    const allFold = Object.fromEntries(s.players.map((p) => [p.id, p.stack]));
    branches.push({ prob: remaining, stacks: allFold });
    perCaller.foldPct = Math.round(remaining * 1000) / 10;
    outcomes.push({ key: 'shove', ev: valueOf(branches, scenario, unit, hero, baseStacks, order), continueProb: 1 - remaining, detail: perCaller });
    if (legal.canFold) outcomes.push(foldOutcome());
    assumptions.push(
      'Villain calling ranges are stated assumptions, not observed facts.',
      'At most one caller is modeled; once a player calls, everyone behind folds.',
      'Callers decide independently of one another (card removal between opponents ignored).',
      'All-in equity is realized fully (no further decisions).',
      'If Hero folds, the remaining players fold to the last player to act, who wins the pot.',
    );
  } else if (model.type === 'call') {
    if (!(legal.toCall > 0)) throw new Error('Call model needs a bet to call');
    const villain = removeBlocked(parseRange(model.villainRange), dead);
    const called = applyAction(state, { type: 'call' });
    const live = called.players.filter((p) => !p.folded);
    if (live.length !== 2) throw new Error('Call model requires exactly two live players');
    const closes = called.awaitingBoard || called.complete;
    const runout = live.filter((p) => !p.allIn).length <= 1;
    if (!closes || !(runout || state.street === 'river')) throw new Error('Call model requires the call to end all betting');
    const eq = equityVsRange(cards, villain, board, { samples: opts.samples ?? DEFAULT_SAMPLES, seed });
    if (model.bountyBB && unit !== 'bb') throw new Error('Bounty models are ChipEV only');
    const win = withBounty(stacksAfter(called, 'win', hero), hero, model.villainPos, (model.bountyBB ?? 0) * scenario.table.bigBlind);
    const lose = stacksAfter(called, 'lose', hero);
    const tie = stacksAfter(called, 'tie', hero);
    const branches = [
      { prob: eq.win, stacks: win },
      { prob: eq.lose, stacks: lose },
      { prob: eq.tie, stacks: tie },
    ];
    if (unit === 'bb') evStdErr = (eq.stdErr * (win[hero]! - lose[hero]!)) / scenario.table.bigBlind;
    outcomes.push({
      key: 'call',
      ev: valueOf(branches, scenario, unit, hero, baseStacks, order),
      equity: eq,
      detail: {
        equityPct: Math.round(eq.equity * 10000) / 100,
        requiredPct: Math.round((legal.callAmount / (legal.pot + legal.callAmount)) * 10000) / 100,
        villainCombos: Math.round(comboCount(villain) * 100) / 100,
      },
    });
    outcomes.push(foldOutcome());
    assumptions.push('Villain range is a stated assumption.', 'Calling ends all betting, so equity is realized fully.');
    if (model.bountyBB) assumptions.push(`If Villain busts, Hero's bounty is valued at a fixed ${model.bountyBB}BB chip-equivalent (simplified PKO model).`);
  } else if (model.type === 'riverBet') {
    if (state.street !== 'river' || state.currentBet !== 0) throw new Error('riverBet model requires an unbet river');
    const villain = removeBlocked(parseRange(model.villainRange), dead);
    const vPlayer = state.players.find((p) => p.id === model.villainPos)!;
    const pot = legal.pot;
    const bb = scenario.table.bigBlind;
    const eqAll = equityVsRange(cards, villain, board);
    outcomes.push({ key: 'check', ev: (eqAll.equity * pot) / bb, equity: eqAll, detail: { equityPct: Math.round(eqAll.equity * 10000) / 100 } });
    model.sizes.forEach((size, i) => {
      const target = size.allIn ? legal.maxRaiseTo : Math.min(legal.maxRaiseTo, Math.max(legal.minRaiseTo, Math.round((size.potFraction ?? 1) * pot)));
      const b = Math.min(target, vPlayer.stack + vPlayer.streetCommitted);
      const callers = intersect(villain, parseRange(size.callRange));
      const pc = comboCount(callers) / comboCount(villain);
      let evCalled = 0;
      let eqc: EquityResult | undefined;
      if (pc > 0) {
        eqc = equityVsRange(cards, callers, board);
        evCalled = eqc.equity * (pot + 2 * b) - b;
      }
      const ev = ((1 - pc) * pot + pc * evCalled) / bb;
      outcomes.push({
        key: `bet:${i}`,
        ev,
        continueProb: pc,
        equity: eqc,
        detail: { betBB: Math.round((b / bb) * 100) / 100, callPct: Math.round(pc * 1000) / 10, equityWhenCalledPct: eqc ? Math.round(eqc.equity * 10000) / 100 : 0 },
      });
    });
    assumptions.push(
      'Villain range and calling ranges are stated assumptions.',
      'If Hero checks, Villain checks back (no bluffs or value bets modeled).',
      'Villain never raises Hero’s bet.',
      'EVs are Hero’s expected share of the pot from this point (check and bet are directly comparable).',
    );
  }
  return { unit, outcomes, assumptions, evStdErr };
}
