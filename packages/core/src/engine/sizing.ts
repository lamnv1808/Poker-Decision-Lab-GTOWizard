import type { LegalActions } from './engine';

/**
 * Bet-sizing helpers. Three different numbers describe a bet and the UI must be explicit:
 *  - raiseTo:  the player's total commitment on this street after acting (engine input)
 *  - added:    additional chips moved from the stack now (raiseTo - already committed)
 *  - increment: raise size over the current bet (raiseTo - currentBet)
 */
export interface SizingBreakdown {
  raiseTo: number;
  added: number;
  increment: number;
  /** raiseTo relative to the pot before acting, as a fraction (bets only meaningful). */
  potFraction: number;
  isAllIn: boolean;
}

export function sizingBreakdown(legal: LegalActions, alreadyCommitted: number, currentBet: number, raiseTo: number): SizingBreakdown {
  return {
    raiseTo,
    added: raiseTo - alreadyCommitted,
    increment: raiseTo - currentBet,
    potFraction: legal.pot > 0 ? (raiseTo - currentBet) / (legal.pot + legal.toCall) : 0,
    isAllIn: raiseTo === legal.maxRaiseTo,
  };
}

/**
 * Pot-fraction bet/raise target.
 * Bet:   raiseTo = fraction × pot.
 * Raise: raiseTo = currentBet + fraction × (pot + toCall)   ("pot-sized raise" when fraction = 1:
 *        call first, then raise the size of the resulting pot).
 * Result is rounded to whole chips and clamped to the legal [min, max] interval.
 */
export function potFractionTarget(legal: LegalActions, currentBet: number, fraction: number): number {
  const raw = currentBet === 0 ? fraction * legal.pot : currentBet + fraction * (legal.pot + legal.toCall);
  return clampSize(legal, Math.round(raw));
}

/** Preflop sizing in big blinds (raise-to total), clamped to legal bounds. */
export function bbTarget(legal: LegalActions, bigBlind: number, bb: number): number {
  return clampSize(legal, Math.round(bb * bigBlind));
}

export function clampSize(legal: LegalActions, amount: number): number {
  return Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, amount));
}

export interface SizePreset {
  key: string;
  raiseTo: number;
  kind: 'bb' | 'pot' | 'allin';
  value: number;
}

export const POSTFLOP_FRACTIONS = [0.25, 0.33, 0.5, 0.75, 1, 1.25, 1.5];
export const PREFLOP_BB = [2, 2.2, 2.5, 3];

/** Legal, de-duplicated presets for the current spot. */
export function sizePresets(legal: LegalActions, street: string, currentBet: number, bigBlind: number): SizePreset[] {
  if (!legal.canBet && !legal.canRaise) return [];
  const out: SizePreset[] = [];
  const seen = new Set<number>();
  const push = (p: SizePreset) => {
    if (p.raiseTo < legal.minRaiseTo || p.raiseTo > legal.maxRaiseTo || seen.has(p.raiseTo)) return;
    seen.add(p.raiseTo);
    out.push(p);
  };
  const unopenedPreflop = street === 'preflop' && currentBet <= bigBlind;
  if (unopenedPreflop) {
    for (const bb of PREFLOP_BB) {
      const raw = Math.round(bb * bigBlind);
      if (raw >= legal.minRaiseTo) push({ key: `${bb}bb`, raiseTo: raw, kind: 'bb', value: bb });
    }
  } else {
    for (const f of POSTFLOP_FRACTIONS) {
      const raw = currentBet === 0 ? Math.round(f * legal.pot) : Math.round(currentBet + f * (legal.pot + legal.toCall));
      if (raw >= legal.minRaiseTo && raw < legal.maxRaiseTo) push({ key: `${Math.round(f * 100)}%`, raiseTo: raw, kind: 'pot', value: f });
    }
  }
  push({ key: 'allin', raiseTo: legal.maxRaiseTo, kind: 'allin', value: legal.maxRaiseTo });
  return out;
}
