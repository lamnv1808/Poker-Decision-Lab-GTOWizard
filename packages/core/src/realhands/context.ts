import type { Card } from '../cards/cards';
import { classOfCombo } from '../cards/range';
import { type HandState, applyAction, computePots, legalActions, totalPot } from '../engine';
import type { ReconstructedHand } from '../hh/gg';
import type { EngineSnapshot } from './audit';

/**
 * Normalized context of one real Hero decision — computed only from information available at the
 * decision (plus the action Hero actually took). This is the unit the leak engine aggregates over.
 */
export const CONTEXT_VERSION = 1;

export type PreflopContext = 'unopened' | 'limped' | 'vsOpen' | 'vs3bet' | 'vs4betPlus' | 'vsAllIn';
export type PostflopContext = 'firstToAct' | 'checkedTo' | 'vsBet' | 'vsRaise' | 'vsAllIn';
export type HeroAction = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
export type StackBucket = '<=10' | '10-15' | '15-25' | '25-40' | '40+';

export interface DecisionContext {
  v: number;
  position: string;
  street: HandState['street'];
  actionContext: PreflopContext | PostflopContext;
  heroAction: HeroAction;
  effStackBB: number;
  stackBucket: StackBucket;
  /** Players still in the hand (not folded), including Hero. */
  playersInHand: number;
  /** Stack-to-pot ratio (postflop only). */
  spr: number | null;
  /** Size of the bet Hero faces, as a fraction of the pot before that bet (postflop only). */
  facingBetPct: number | null;
  /** Equity needed to call, using only pots Hero can win. */
  requiredEquity: number | null;
  formatGroup: 'PKO' | 'regular';
  heroClass: string | null;
}

export function stackBucket(bb: number): StackBucket {
  return bb <= 10 ? '<=10' : bb <= 15 ? '10-15' : bb <= 25 ? '15-25' : bb <= 40 ? '25-40' : '40+';
}

export function decisionContext(rec: ReconstructedHand, snap: EngineSnapshot, format: string): DecisionContext {
  const s = snap.state;
  const bb = rec.parsed.bigBlind;
  const hero = s.players.find((p) => p.id === snap.heroId)!;
  const legal = snap.legal ?? legalActions(s);
  const act = rec.parsed.actions[snap.actionIndex]!;
  const streetActs = s.history.filter((h) => h.street === s.street && ['fold', 'check', 'call', 'bet', 'raise'].includes(h.type));
  const raises = streetActs.filter((h) => h.type === 'raise' || h.type === 'bet');
  const facingAllIn = (legal?.toCall ?? 0) > 0 && s.players.some((p) => p.id !== hero.id && !p.folded && p.allIn);
  let actionContext: DecisionContext['actionContext'];
  if (s.street === 'preflop') {
    const voluntaryRaises = raises.length;
    if (facingAllIn && (legal?.toCall ?? 0) > 0) actionContext = 'vsAllIn';
    else if (voluntaryRaises === 0) actionContext = streetActs.some((h) => h.type === 'call') ? 'limped' : 'unopened';
    else actionContext = voluntaryRaises === 1 ? 'vsOpen' : voluntaryRaises === 2 ? 'vs3bet' : 'vs4betPlus';
  } else if (facingAllIn) actionContext = 'vsAllIn';
  else if (raises.length >= 2) actionContext = 'vsRaise';
  else if (raises.length === 1) actionContext = 'vsBet';
  else actionContext = streetActs.length === 0 ? 'firstToAct' : 'checkedTo';

  const heroAction: HeroAction = act.type === 'fold' ? 'fold' : act.type === 'check' ? 'check' : act.allIn && act.type !== 'call' ? 'allin' : act.type;
  const opps = s.players.filter((p) => !p.folded && p.id !== hero.id);
  const eff = Math.min(hero.stack + hero.streetCommitted, Math.max(0, ...opps.map((p) => p.stack + p.streetCommitted))) / bb;
  const pot = totalPot(s);
  let requiredEquity: number | null = null;
  // pot odds only where Hero faces a bet/raise (completing the blind unopened is not a pot-odds spot)
  if (legal && legal.toCall > 0 && actionContext !== 'unopened' && actionContext !== 'limped') {
    const after = applyAction(s, { type: 'call' });
    const winnable = computePots(after).filter((p) => p.eligible.includes(hero.id)).reduce((a, p) => a + p.amount, 0);
    requiredEquity = Math.round((legal.callAmount / winnable) * 10000) / 10000;
  }
  let facingBetPct: number | null = null;
  if (s.street !== 'preflop' && legal && legal.toCall > 0) {
    // the current bet measured against the pot at the start of this street
    const potAtStreetStart = pot - s.players.reduce((a, p) => a + p.streetCommitted, 0);
    facingBetPct = potAtStreetStart > 0 ? Math.round((s.currentBet / potAtStreetStart) * 100) / 100 : null;
  }
  const cards = rec.parsed.heroCards;
  return {
    v: CONTEXT_VERSION,
    position: rec.positions[hero.id] ?? rec.heroPosition ?? '?',
    street: s.street,
    actionContext,
    heroAction,
    effStackBB: Math.round(eff * 10) / 10,
    stackBucket: stackBucket(eff),
    playersInHand: opps.length + 1,
    spr: s.street === 'preflop' ? null : Math.round((Math.min(hero.stack, Math.max(0, ...opps.map((p) => p.stack))) / Math.max(1, pot)) * 100) / 100,
    facingBetPct,
    requiredEquity,
    formatGroup: /PKO|bounty/i.test(format) ? 'PKO' : 'regular',
    heroClass: cards && cards.length === 2 ? classOfCombo(cards[0] as Card, cards[1] as Card) : null,
  };
}
