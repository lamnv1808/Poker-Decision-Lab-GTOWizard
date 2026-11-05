import { applyAction, computePots, legalActions, type HandState, type PlayerAction } from '../engine/engine';

/**
 * Decision Maths (Phase 4B, Gate 1) — deterministic arithmetic about ONE Hero decision, computed from the engine
 * state immediately before Hero acts. Feature-flagged (DQE_DECISION_MATHS, default off); never grades anything.
 *
 * Evidence classes (sub-classes of the existing DQE category EXACT_MATHEMATICAL_RESULT; no parallel taxonomy):
 *  - ARITHMETIC_IDENTITY: true for these chips and this pot (pot odds, required equity, all-in threshold, SPR,
 *    bet as a fraction of the pot, risk/reward, effective stack). Says nothing about what Hero should do.
 *  - CONDITIONAL_MODEL_REFERENCE: exact ONLY inside a stated toy model (minimum defence frequency, break-even fold
 *    frequency of a zero-equity bet). Emitted only where the model's applicability conditions hold; otherwise the
 *    calculation is returned as UNSUPPORTED with a reason.
 * The strategic verdict is always NOT_ESTABLISHED: a price is not a recommendation without a reliable equity or
 * fold-probability estimate, which this module does not have.
 *
 * Pot definitions (chips; reported in BB):
 *  - P_call: everything Hero can win by calling, BEFORE Hero's pending call — includes the opponent's wager,
 *    excludes Hero's call and any side pot Hero is not eligible for (engine pot computation).
 *  - P_bet: the pot before Hero's bet or raise (includes a bet Hero is raising).
 */

export const DECISION_MATH_VERSION = 'pdl-decision-math-v2';

export type MathFactId =
  | 'effectiveStack'
  | 'spr'
  | 'callAmount'
  | 'potOdds'
  | 'requiredEquity'
  | 'allInCallThreshold'
  | 'minimumDefenceFrequency'
  | 'betFractionOfPot'
  | 'riskReward'
  | 'breakEvenFoldFrequency'
  | 'uncalledExcess';

export type MathFactClass = 'ARITHMETIC_IDENTITY' | 'CONDITIONAL_MODEL_REFERENCE';

export interface MathInput {
  name: string;
  value: number;
  unit: 'BB' | 'count';
}

export interface MathFact {
  id: MathFactId;
  /** stable formula identifier, e.g. pdl.math.requiredEquity.v1 */
  formulaId: string;
  /** the formula in symbols, e.g. "C / (P + C)" */
  formula: string;
  inputs: MathInput[];
  value: number;
  unit: 'fraction' | 'ratio' | 'BB';
  class: MathFactClass;
  /** existing DQE taxonomy: every fact here is exact arithmetic (conditional facts: exact within their model) */
  evidenceCategory: 'EXACT_MATHEMATICAL_RESULT';
  assumptions: string[];
  /** conditions that were checked and hold for this decision */
  applicability: string[];
  caveats: string[];
  notAStrategy: true;
}

export interface UnsupportedCalc {
  id: MathFactId;
  class: 'UNSUPPORTED';
  reason: string;
}

export interface DecisionMathResult {
  version: typeof DECISION_MATH_VERSION;
  status: 'ok' | 'unsupported';
  unsupportedReason: string | null;
  facts: MathFact[];
  unsupported: UnsupportedCalc[];
  strategicVerdict: 'NOT_ESTABLISHED';
  strategicVerdictReason: string;
  /** this module never makes a decision gradeable */
  gradeable: false;
  context: {
    street: string;
    chosen: PlayerAction['type'];
    liveOpponents: number;
    potBB: number;
    facingBB: number;
    heroAddsBB: number | null;
    sidePots: number;
    multiway: boolean;
    heroAllInForLess: boolean;
    economics: string;
  };
}

export interface DecisionMathOptions {
  /** 'chipEV' (default) | 'PKO' | 'ICM' | … — payoffs beyond chips make conditional model references unsupported */
  economics?: string;
}

const r4 = (x: number) => Math.round(x * 1e6) / 1e6; // fractions keep 6 decimals (a 2-chip all-in into 500 BB is 4e-5, not 0)
const r2 = (x: number) => Math.round(x * 100) / 100;
const fid = (id: MathFactId) => `pdl.math.${id}.v1`;
const VERDICT_REASON = 'Arithmetic alone does not show whether this action is correct: that needs an estimate of Hero’s equity against the opponent’s range or of the opponent’s fold probability, which these numbers do not include. Any rating shown elsewhere comes from the existing grader, not from this section.';

export function decisionMath(s: HandState, heroId: string, chosen: PlayerAction, o: DecisionMathOptions = {}): DecisionMathResult {
  const economics = o.economics ?? 'chipEV';
  const bb = s.config.bigBlind;
  const ctx = (extra: Partial<DecisionMathResult['context']> = {}): DecisionMathResult['context'] => ({ street: s.street, chosen: chosen.type, liveOpponents: 0, potBB: 0, facingBB: 0, heroAddsBB: null, sidePots: 0, multiway: false, heroAllInForLess: false, economics, ...extra });
  const out = (status: 'ok' | 'unsupported', reason: string | null, facts: MathFact[], unsupported: UnsupportedCalc[], c: DecisionMathResult['context']): DecisionMathResult => ({
    version: DECISION_MATH_VERSION, status, unsupportedReason: reason, facts, unsupported, strategicVerdict: 'NOT_ESTABLISHED', strategicVerdictReason: VERDICT_REASON, gradeable: false, context: c,
  });

  // ---- whole-decision applicability
  if (!(bb > 0) || !Number.isFinite(bb)) return out('unsupported', 'big blind unknown or invalid', [], [], ctx());
  const hero = s.players.find((p) => p.id === heroId);
  if (!hero) return out('unsupported', 'Hero is not in this hand state', [], [], ctx());
  if (s.players.some((p) => !Number.isFinite(p.stack) || p.stack < 0 || !Number.isFinite(p.streetCommitted) || p.streetCommitted < 0 || !Number.isFinite(p.totalCommitted)))
    return out('unsupported', 'incomplete or malformed hand history: a stack or a commitment is unknown', [], [], ctx());
  const legal = legalActions(s);
  if (!legal || legal.playerId !== heroId) return out('unsupported', 'it is not Hero’s turn in this state (incomplete or inconsistent action sequence)', [], [], ctx());
  const pots = computePots(s);
  const potChips = pots.reduce((a, p) => a + p.amount, 0);
  if (!(potChips > 0)) return out('unsupported', 'the pot is empty or invalid', [], [], ctx());

  const opps = s.players.filter((p) => p.id !== heroId && !p.folded);
  const multiway = opps.length > 1;
  const nonChip = economics !== 'chipEV';
  const facts: MathFact[] = [];
  const unsupported: UnsupportedCalc[] = [];
  const nonChipCaveat = nonChip ? [`${economics}: chip arithmetic only — bounty or tournament equity changes what a chip is worth, so the chip-EV break-even is not the real one.`] : [];
  const bbIn = (name: string, chips: number): MathInput => ({ name, value: r2(chips / bb), unit: 'BB' });
  const add = (f: Omit<MathFact, 'formulaId' | 'evidenceCategory' | 'notAStrategy'>) => facts.push({ ...f, formulaId: fid(f.id), evidenceCategory: 'EXACT_MATHEMATICAL_RESULT', notAStrategy: true });
  const no = (id: MathFactId, reason: string) => unsupported.push({ id, class: 'UNSUPPORTED', reason });

  // ---- effective stack and SPR (descriptive identities)
  const oppMax = Math.max(0, ...opps.map((p) => p.stack));
  const eff = Math.min(hero.stack, oppMax);
  add({ id: 'effectiveStack', formula: 'min(Hero behind, largest opponent behind)', inputs: [bbIn('Hero behind', hero.stack), bbIn('largest opponent behind', oppMax)], value: r2(eff / bb), unit: 'BB', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: ['stacks known'], caveats: [] });
  add({ id: 'spr', formula: 'effective stack ÷ pot', inputs: [bbIn('effective stack', eff), bbIn('pot', potChips)], value: r2(eff / potChips), unit: 'ratio', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: ['pot > 0'], caveats: ['Describes the situation at this decision; it does not say whether to check, bet, call or raise.'] });

  // ---- facing a bet: price of calling
  let heroAllInForLess = false;
  let sidePots = 0;
  if (legal.toCall > 0) {
    const C = legal.callAmount; // capped by Hero's stack
    heroAllInForLess = legal.callIsAllIn && C < legal.toCall;
    const after = applyAction(s, { type: 'call' });
    const potsAfter = computePots(after);
    sidePots = Math.max(0, potsAfter.length - 1);
    const winnable = potsAfter.filter((p) => p.eligible.includes(heroId)).reduce((a, p) => a + p.amount, 0);
    const P = winnable - C;
    const canStillBet = after.players.filter((p) => !p.folded && !p.allIn && p.stack > 0).length >= 2;
    const behind = after.players.some((p) => p.id !== heroId && !p.folded && !p.allIn && p.stack > 0 && !p.hasActed);
    add({ id: 'callAmount', formula: 'C = min(amount to call, Hero behind)', inputs: [bbIn('amount to call', legal.toCall), bbIn('Hero behind', hero.stack)], value: r2(C / bb), unit: 'BB', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: ['facing a bet'], caveats: heroAllInForLess ? ['Hero’s call is all-in for less than the bet; the excess forms a side pot Hero cannot win.'] : [] });
    add({ id: 'potOdds', formula: 'P : C', inputs: [bbIn('P (pot Hero can win, before Hero’s call)', P), bbIn('C (call)', C)], value: r2(P / C), unit: 'ratio', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: ['facing a bet', ...(sidePots ? ['side pots excluded from P'] : [])], caveats: [] });
    const reqInputs = [bbIn('P', P), bbIn('C', C)];
    if (!canStillBet) {
      add({ id: 'allInCallThreshold', formula: 'C / (P + C)', inputs: reqInputs, value: r4(C / (P + C)), unit: 'fraction', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: ['no further betting is possible after the call'], caveats: [...nonChipCaveat, 'Hero’s real equity against the opponent’s range is not known here.'] });
    } else {
      // a call that closes the river action ends the betting: the threshold is final (no implied odds)
      const closesRiver = s.street === 'river' && legalActions(after) === null;
      add({ id: 'requiredEquity', formula: 'C / (P + C)', inputs: reqInputs, value: r4(C / (P + C)), unit: 'fraction', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: ['facing a bet', ...(closesRiver ? ['the call closes the river action'] : [])], caveats: [closesRiver ? 'No betting follows this call: this is the final break-even equity.' : 'Break-even equity for this call only: later betting (implied / reverse implied odds) is not included.', ...(behind ? ['Players behind can still raise, so the price is not final.'] : []), ...nonChipCaveat] });
    }
    // minimum defence frequency: one bettor, one defender, pure-bluff model
    const bettorAllIn = opps.some((p) => p.allIn);
    const B = legal.toCall; // the bet Hero faces beyond Hero's street commitment
    const P0 = potChips - B; // pot before that bet
    if (multiway) no('minimumDefenceFrequency', 'multiway pot: the reference is defined for one bettor and one defender; with several defenders it is a joint requirement, not a per-player one');
    else if (heroAllInForLess) no('minimumDefenceFrequency', 'Hero cannot cover the bet (all-in for less)');
    else if (bettorAllIn || !canStillBet) no('minimumDefenceFrequency', 'the bettor is all-in: no future bluffing to deter — use the all-in call threshold');
    else if (nonChip) no('minimumDefenceFrequency', `${economics}: payoffs are not just the chip pot`);
    else if (!(P0 > 0)) no('minimumDefenceFrequency', 'no pot before the bet');
    else
      add({ id: 'minimumDefenceFrequency', formula: 'P0 / (P0 + B)', inputs: [bbIn('P0 (pot before the bet)', P0), bbIn('B (bet)', B)], value: r4(P0 / (P0 + B)), unit: 'fraction', class: 'CONDITIONAL_MODEL_REFERENCE', assumptions: ['The bettor’s bluffs have zero equity when called.', 'One street; no raises, no later betting, no card removal.'], applicability: ['heads-up', 'bettor not all-in', 'chip EV'], caveats: ['A theoretical reference for a whole range, not an instruction to defend any particular hand.'] });
  }

  // ---- Hero bets or raises: size, risk, reward, break-even fold frequency
  let heroAddsBB: number | null = null;
  if ((chosen.type === 'bet' || chosen.type === 'raise') && chosen.amount !== undefined) {
    const to = Math.min(chosen.amount, hero.streetCommitted + hero.stack); // amount = Hero's street total
    const maxMatch = Math.max(0, ...opps.map((p) => p.streetCommitted + p.stack)); // the most any opponent can reach
    const matchedTo = Math.min(to, maxMatch);
    const uncalled = Math.max(0, to - maxMatch);
    const R = matchedTo - hero.streetCommitted; // chips at risk if called
    const Pb = potChips; // pot before Hero's bet/raise (incl. a bet being raised)
    heroAddsBB = r2((to - hero.streetCommitted) / bb);
    if (uncalled > 0) add({ id: 'uncalledExcess', formula: 'Hero’s total − most any opponent can match', inputs: [bbIn('Hero’s street total', to), bbIn('most an opponent can match', maxMatch)], value: r2(uncalled / bb), unit: 'BB', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: ['bet larger than every opponent can call'], caveats: ['This part is returned uncalled and changes nothing.'] });
    if (!(R > 0)) {
      for (const id of ['betFractionOfPot', 'riskReward', 'breakEvenFoldFrequency'] as const) no(id, 'no opponent can call any part of this bet');
    } else {
      const isRaise = legal.toCall > 0;
      add({ id: 'betFractionOfPot', formula: isRaise ? 'R / P (raise: R = chips Hero adds that can be called, P = pot incl. the bet being raised)' : 'R / P', inputs: [bbIn('R (at risk)', R), bbIn('P (pot before Hero’s action)', Pb)], value: r4(R / Pb), unit: 'ratio', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: [isRaise ? 'raise' : 'bet'], caveats: [] });
      add({ id: 'riskReward', formula: 'R : P', inputs: [bbIn('R (at risk if called)', R), bbIn('P (pot before Hero’s action)', Pb)], value: r4(R / Pb), unit: 'ratio', class: 'ARITHMETIC_IDENTITY', assumptions: [], applicability: ['chips at risk only if called'], caveats: [] });
      if (multiway) no('breakEvenFoldFrequency', 'multiway pot: needs the joint probability that every opponent folds; the formula assumes one opponent');
      else if (nonChip) no('breakEvenFoldFrequency', `${economics}: payoffs are not just the chip pot`);
      else
        add({ id: 'breakEvenFoldFrequency', formula: 'R / (P + R)', inputs: [bbIn('R', R), bbIn('P', Pb)], value: r4(R / (Pb + R)), unit: 'fraction', class: 'CONDITIONAL_MODEL_REFERENCE', assumptions: ['Hero’s hand has zero equity when called (a pure bluff).', isRaise ? 'The opponent only folds or calls (no re-raise), single street.' : 'The opponent only folds or calls (no raise), single street.'], applicability: ['heads-up', 'chip EV'], caveats: ['With showdown equity a bet needs fewer folds than this; over several streets the model does not apply.', 'Whether the opponent folds this often is not known here.'] });
    }
  }

  return out('ok', null, facts, unsupported, ctx({ liveOpponents: opps.length, potBB: r2(potChips / bb), facingBB: r2(legal.toCall / bb), heroAddsBB, sidePots, multiway, heroAllInForLess }));
}

/** Facts that price the CHOSEN action (used for coverage audits; never for grading). */
export function pricesChosenAction(m: DecisionMathResult): boolean {
  const ids = new Set(m.facts.map((f) => f.id));
  if (m.context.chosen === 'bet' || m.context.chosen === 'raise') return ids.has('riskReward');
  if (m.context.chosen === 'call' || m.context.chosen === 'fold') return ids.has('requiredEquity') || ids.has('allInCallThreshold');
  return false;
}
