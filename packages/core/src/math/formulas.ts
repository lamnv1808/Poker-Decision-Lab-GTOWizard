/**
 * Exact poker mathematics. Every function is a closed-form formula with stated
 * assumptions; nothing here is estimated or solver-derived.
 * Units: any consistent chip unit (chips or BB). Results that are fractions are in [0,1].
 */

function assertNonNeg(...xs: number[]): void {
  for (const x of xs) if (!(x >= 0) || !Number.isFinite(x)) throw new Error(`Expected a non-negative number, got ${x}`);
}

/**
 * Required equity to call.
 * @param callAmount chips Hero must add to call
 * @param potBeforeCall total pot INCLUDING Villain's current bet, before Hero calls
 */
export function requiredEquity(callAmount: number, potBeforeCall: number): number {
  assertNonNeg(callAmount, potBeforeCall);
  if (callAmount === 0) return 0;
  return callAmount / (potBeforeCall + callAmount);
}

/** Pot odds as "X : 1" (reward : risk). */
export function potOddsRatio(callAmount: number, potBeforeCall: number): number {
  assertNonNeg(callAmount, potBeforeCall);
  return potBeforeCall / callAmount;
}

/**
 * Break-even fold frequency for a bluff with zero equity when called.
 * @param risk chips Hero bets
 * @param potBeforeBluff pot before Hero's bet
 */
export function bluffBreakEven(risk: number, potBeforeBluff: number): number {
  assertNonNeg(risk, potBeforeBluff);
  return risk / (potBeforeBluff + risk);
}

/**
 * Minimum defense frequency: the share of its range the defender must continue
 * with so a zero-equity bluff does not profit automatically.
 * Assumptions: bettor's bluffs have 0 equity; ignores future streets, ranges' real
 * composition, and card removal. MDF is a reference point, not a strategy.
 */
export function mdf(potBeforeBet: number, bet: number): number {
  assertNonNeg(potBeforeBet, bet);
  return potBeforeBet / (potBeforeBet + bet);
}

/**
 * River polarized model (bettor holds nuts or air, caller holds bluff-catchers):
 * share of bluffs in the betting range that makes the caller indifferent.
 */
export function indifferentBluffShare(potBeforeBet: number, bet: number): number {
  assertNonNeg(potBeforeBet, bet);
  return bet / (potBeforeBet + 2 * bet);
}

/** Value : bluff ratio under the same model: (pot + bet) : bet, returned as value per 1 bluff. */
export function valuePerBluff(potBeforeBet: number, bet: number): number {
  assertNonNeg(potBeforeBet, bet);
  return (potBeforeBet + bet) / bet;
}

/** Stack-to-pot ratio. */
export function spr(effectiveStack: number, pot: number): number {
  assertNonNeg(effectiveStack, pot);
  if (pot === 0) throw new Error('Pot must be positive');
  return effectiveStack / pot;
}

/** EV of calling relative to folding, assuming no further betting (all-in or river). */
export function evCall(equity: number, potBeforeCall: number, callAmount: number): number {
  assertNonNeg(potBeforeCall, callAmount);
  return equity * (potBeforeCall + callAmount) - callAmount;
}

/**
 * EV of a bet relative to checking down (0), with no further action after a call.
 * @param foldFreq probability Villain folds
 * @param equityWhenCalled Hero equity vs Villain's calling range
 */
export function evBet(foldFreq: number, potBeforeBet: number, bet: number, equityWhenCalled = 0): number {
  assertNonNeg(potBeforeBet, bet);
  return foldFreq * potBeforeBet + (1 - foldFreq) * (equityWhenCalled * (potBeforeBet + 2 * bet) - bet);
}

/** Exact probability of hitting at least one of `outs` with `cardsToCome` (1 or 2) from `unseen` cards. */
export function hitProbability(outs: number, unseen: number, cardsToCome: 1 | 2): number {
  if (!Number.isInteger(outs) || !Number.isInteger(unseen) || outs < 0 || outs > unseen) throw new Error('Invalid outs');
  if (cardsToCome === 1) return outs / unseen;
  const miss = ((unseen - outs) * (unseen - outs - 1)) / (unseen * (unseen - 1));
  return 1 - miss;
}

/** Rule of 2 and 4 approximation (percent → fraction). */
export function ruleOf2And4(outs: number, cardsToCome: 1 | 2): number {
  return (outs * (cardsToCome === 1 ? 2 : 4)) / 100;
}

/**
 * Implied odds: extra chips Hero must win on later streets when the draw hits
 * to make a call break even. Simplified model (wins only when hitting).
 */
export function impliedOddsNeeded(equity: number, potBeforeCall: number, callAmount: number): number {
  assertNonNeg(potBeforeCall, callAmount);
  if (!(equity > 0)) return Infinity;
  const needed = callAmount / equity - (potBeforeCall + callAmount);
  return Math.max(0, needed);
}

export function round(x: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

export function toBB(chips: number, bigBlind: number): number {
  return chips / bigBlind;
}
