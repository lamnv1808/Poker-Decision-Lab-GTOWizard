import { applyAction, computePots, legalActions, type HandState, type PlayerAction } from '../engine/engine';

/**
 * Deterministic decision mathematics for one Hero decision (any street), computed from the engine state
 * immediately before Hero acts. PROTOTYPE (Phase 4A) — not wired into feedback or grading.
 *
 * Two kinds of output, never mixed:
 *  - `identity`: arithmetic that is true for this pot and these stacks (pot odds of a call, the all-in call
 *    threshold, stack-to-pot ratio, risk/reward of a bet). No strategy is implied.
 *  - `modelReference`: a reference point that is exact only INSIDE a stated toy model (minimum defence
 *    frequency, break-even fold frequency of a zero-equity bluff). Always carries the model assumptions and
 *    `notAStrategy: true`; extra caveats are attached for multiway pots, all-ins, and ICM/PKO formats.
 * Side pots come from the engine's own pot computation; bets larger than anyone can call are capped at the
 * largest amount that can actually be matched (the rest is returned uncalled).
 */

export const POSTFLOP_MATH_VERSION = 'pdl-decision-math-v1';

export type MathFactKey =
  | 'callAmount'
  | 'potOdds'
  | 'requiredEquity'
  | 'allInCallThreshold'
  | 'spr'
  | 'riskReward'
  | 'breakEvenFoldFrequency'
  | 'minimumDefenceFrequency'
  | 'uncalledExcess';

export interface MathFact {
  key: MathFactKey;
  value: number;
  unit: 'fraction' | 'ratio' | 'BB';
  kind: 'identity' | 'modelReference';
  /** model assumptions (modelReference only) */
  assumptions: string[];
  /** context-specific reasons the number must not be read as a strategy */
  caveats: string[];
  notAStrategy: true;
}

export interface DecisionMathResult {
  version: typeof POSTFLOP_MATH_VERSION;
  status: 'ok' | 'unsupported';
  /** why nothing (or only part) could be computed */
  unsupportedReason: string | null;
  facts: MathFact[];
  context: { street: string; liveOpponents: number; potBB: number; facingBetBB: number; heroActionBB: number | null; sidePots: number; multiway: boolean; heroAllInForLess: boolean };
}

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const r2 = (x: number) => Math.round(x * 100) / 100;

export interface DecisionMathOptions {
  /** 'chipEV' | 'PKO' | 'ICM' | … — non-chip-EV formats add caveats to every model reference */
  economics?: string;
}

export function decisionMath(s: HandState, heroId: string, chosen: PlayerAction, o: DecisionMathOptions = {}): DecisionMathResult {
  const bb = s.config.bigBlind;
  const empty = (reason: string): DecisionMathResult => ({ version: POSTFLOP_MATH_VERSION, status: 'unsupported', unsupportedReason: reason, facts: [], context: { street: s.street, liveOpponents: 0, potBB: 0, facingBetBB: 0, heroActionBB: null, sidePots: 0, multiway: false, heroAllInForLess: false } });
  if (!(bb > 0)) return empty('big blind unknown');
  const hero = s.players.find((p) => p.id === heroId);
  if (!hero) return empty('hero not in hand state');
  const bad = s.players.find((p) => !Number.isFinite(p.stack) || p.stack < 0 || !Number.isFinite(p.streetCommitted) || !Number.isFinite(p.totalCommitted));
  if (bad) return empty('incomplete hand history: a stack or commitment is unknown');
  const legal = legalActions(s);
  if (!legal || legal.playerId !== heroId) return empty('it is not Hero’s turn in this state');

  const opps = s.players.filter((p) => p.id !== heroId && !p.folded);
  const potChips = computePots(s).reduce((a, p) => a + p.amount, 0);
  const facts: MathFact[] = [];
  const caveatsFor = (multiway: boolean, extra: string[] = []) => {
    const c = [...extra];
    if (multiway) c.push('Multiway: the reference is defined for one defender facing one bettor; with several opponents it is a joint requirement on all of them, not a per-player target.');
    if (o.economics && o.economics !== 'chipEV') c.push(`${o.economics}: chip-count arithmetic only; tournament equity / bounty value changes what a chip is worth.`);
    c.push('Ignores rake and future betting.');
    return c;
  };
  const heroBehind = hero.stack;
  const effStack = Math.min(heroBehind, Math.max(0, ...opps.map((p) => p.stack)));
  const multiway = opps.length > 1;

  // ---- stack-to-pot ratio (identity) — measured at the decision, before Hero acts
  if (potChips > 0) facts.push({ key: 'spr', value: r2(effStack / potChips), unit: 'ratio', kind: 'identity', assumptions: [], caveats: ['Measured at this decision (effective stack behind ÷ current pot), not at the start of the street.'], notAStrategy: true });

  // ---- facing a bet: price of calling
  let heroAllInForLess = false;
  let sidePots = 0;
  if (legal.toCall > 0) {
    const call = legal.callAmount; // capped by Hero's stack
    heroAllInForLess = legal.callIsAllIn && call < legal.toCall;
    const after = applyAction(s, { type: 'call' });
    const pots = computePots(after);
    sidePots = Math.max(0, pots.length - 1);
    const winnable = pots.filter((p) => p.eligible.includes(heroId)).reduce((a, p) => a + p.amount, 0);
    const req = call / winnable;
    facts.push({ key: 'callAmount', value: r2(call / bb), unit: 'BB', kind: 'identity', assumptions: [], caveats: heroAllInForLess ? ['Hero’s call is all-in for less than the bet; the excess forms a side pot Hero cannot win.'] : [], notAStrategy: true });
    facts.push({ key: 'potOdds', value: r2((winnable - call) / call), unit: 'ratio', kind: 'identity', assumptions: [], caveats: ['Counts only the pots Hero is eligible to win (side pots excluded).'], notAStrategy: true });
    // after the call, can anyone still bet? If at most one player has chips behind, no further betting is
    // possible and the break-even equity is exact chip arithmetic (the "all-in call threshold").
    const canStillBet = after.players.filter((p) => !p.folded && !p.allIn && p.stack > 0).length >= 2;
    if (!canStillBet) {
      facts.push({ key: 'allInCallThreshold', value: r4(req), unit: 'fraction', kind: 'identity', assumptions: [], caveats: o.economics && o.economics !== 'chipEV' ? [`${o.economics}: chip-EV break-even; tournament equity / bounty value move the real threshold.`] : [], notAStrategy: true });
    } else {
      const playersBehind = after.players.some((p) => p.id !== heroId && !p.folded && !p.allIn && p.stack > 0 && !p.hasActed);
      facts.push({ key: 'requiredEquity', value: r4(req), unit: 'fraction', kind: 'identity', assumptions: [], caveats: ['Break-even equity for this call only: future betting (implied / reverse implied odds) is not included.', ...(playersBehind ? ['Players behind can still raise, so the price is not final.'] : [])], notAStrategy: true });
    }
    // minimum defence frequency vs the bet Hero faces (model reference)
    const betFaced = legal.toCall; // chips the bettor put in beyond Hero's street commitment
    const potBeforeBet = potChips - betFaced;
    if (potBeforeBet > 0 && !heroAllInForLess) {
      facts.push({
        key: 'minimumDefenceFrequency', value: r4(potBeforeBet / (potBeforeBet + betFaced)), unit: 'fraction', kind: 'modelReference',
        assumptions: ['The bettor’s bluffs have zero equity when called.', 'One street, no future betting, no card removal.'],
        caveats: caveatsFor(multiway, ['A defence target that makes a zero-equity bluff break even; real strategy depends on ranges, board and opponents.', ...(opps.some((p) => p.allIn) ? ['The bettor is all-in: there is no future bluffing to deter, so MDF has little meaning here; use the all-in threshold.'] : [])]),
        notAStrategy: true,
      });
    }
  }

  // ---- Hero bets or raises: risk, reward, break-even fold frequency
  let heroActionBB: number | null = null;
  if ((chosen.type === 'bet' || chosen.type === 'raise') && chosen.amount !== undefined) {
    const to = Math.min(chosen.amount, hero.streetCommitted + hero.stack); // amount is the street total
    const added = to - hero.streetCommitted;
    // the most any opponent can match on this street
    const maxMatch = Math.max(0, ...opps.map((p) => p.streetCommitted + p.stack));
    const matchedTo = Math.min(to, maxMatch);
    const uncalled = to - matchedTo;
    const risk = matchedTo - hero.streetCommitted; // chips actually at risk if called
    const reward = potChips; // everything already in the pot (incl. any bet Hero is raising)
    heroActionBB = r2(added / bb);
    if (uncalled > 0) facts.push({ key: 'uncalledExcess', value: r2(uncalled / bb), unit: 'BB', kind: 'identity', assumptions: [], caveats: ['No opponent can match this part of the bet; it is returned uncalled and changes nothing.'], notAStrategy: true });
    if (risk > 0 && reward > 0) {
      facts.push({ key: 'riskReward', value: r4(risk / reward), unit: 'ratio', kind: 'identity', assumptions: [], caveats: ['Chips Hero can lose if called, per chip already in the pot (for a bet this is the bet as a fraction of the pot).'], notAStrategy: true });
      facts.push({
        key: 'breakEvenFoldFrequency', value: r4(risk / (reward + risk)), unit: 'fraction', kind: 'modelReference',
        assumptions: ['Hero’s hand has zero equity when called (a pure bluff).', 'Every opponent folds or one calls; no raises, no future streets.'],
        caveats: caveatsFor(multiway, [...(multiway ? ['With several opponents, ALL of them must fold this often combined.'] : []), 'With real equity when called, a bet needs fewer folds than this.']),
        notAStrategy: true,
      });
    }
  }

  return {
    version: POSTFLOP_MATH_VERSION,
    status: 'ok',
    unsupportedReason: null,
    facts,
    context: { street: s.street, liveOpponents: opps.length, potBB: r2(potChips / bb), facingBetBB: r2(legal.toCall / bb), heroActionBB, sidePots, multiway, heroAllInForLess },
  };
}

/** Facts that may appear in user feedback as numbers; model references must be shown with their assumptions. */
export const isIdentity = (f: MathFact) => f.kind === 'identity';
