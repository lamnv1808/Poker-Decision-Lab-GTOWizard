import { classOfCombo } from '../cards/range';
import type { ReconstructedHand } from '../hh/gg';
import { type GtoAction, type GtoRole, gradeGtoSpot } from './quiz';
import { solvePushFold } from './pushfold';
import type { Grade } from '../scenario/grading';

/**
 * Finds heads-up push/fold decisions in a real hand and grades Hero against the equilibrium.
 * Spots: folded to Hero in the SB (shove or fold), or Hero in the BB facing an SB all-in after
 * everyone else folded. Effective stack ≤ 15BB. Stack is rounded to 0.5BB and dead antes to the
 * nearest precomputed level — stated as an approximation.
 */
export const AUDIT_DEAD_LEVELS = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];
export const AUDIT_MAX_STACK = 15;

export interface PushFoldAudit {
  role: GtoRole;
  stackBB: number;
  deadBB: number;
  /** Exact values before rounding to the solved grid. */
  exactStackBB: number;
  exactDeadBB: number;
  heroClass: string;
  heroCards: string[];
  heroAction: GtoAction | 'other';
  /** Present only when the action is inside the push/fold model. */
  grade: Grade | null;
  evLossBB: number | null;
  frequency: number;
  evAggressive: number;
  bestAction: string;
  actionIndex: number;
}

const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const nearest = (x: number, levels: number[]) => levels.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));

export function auditPushFold(h: ReconstructedHand): PushFoldAudit | null {
  const hero = h.parsed.heroName;
  const cards = h.parsed.heroCards;
  if (!hero || !cards || cards.length !== 2) return null;
  const pre = h.parsed.actions.filter((a) => a.street === 'preflop');
  const heroIdx = pre.findIndex((a) => a.player === hero);
  if (heroIdx < 0) return null;
  const n = h.table.players.length;
  const sbId = h.table.players[0]!.id;
  const bbId = h.table.players[1]!.id;
  const bb = h.parsed.bigBlind;
  const state = h.statesBefore[h.parsed.actions.indexOf(pre[heroIdx]!)]!;
  const sb = state.players.find((p) => p.id === sbId)!;
  const bbP = state.players.find((p) => p.id === bbId)!;
  const exactDead = state.deadAntes / bb;
  let role: GtoRole;
  if (hero === sbId && n >= 2) {
    if (!pre.slice(0, heroIdx).every((a) => a.type === 'fold')) return null;
    role = 'sbShove';
  } else if (hero === bbId) {
    const before = pre.slice(0, heroIdx);
    const sbAct = before.filter((a) => a.player === sbId);
    const others = before.filter((a) => a.player !== sbId);
    if (!others.every((a) => a.type === 'fold') || sbAct.length !== 1) return null;
    const s = sbAct[0]!;
    // SB must have put Hero to a decision for (effectively) all chips
    const heroBehind = bbP.stack + bbP.streetCommitted;
    if (!(s.type === 'raise' && (s.allIn || s.amount >= heroBehind))) return null;
    role = 'bbCall';
  } else return null;
  if (sb.allIn && role === 'sbShove') return null;
  // effective stack: chips each could put in this hand (blind included), after antes
  const exactStack = Math.min(sb.stack + sb.streetCommitted, bbP.stack + bbP.streetCommitted) / bb;
  if (exactStack > AUDIT_MAX_STACK + 0.25 || exactStack < 1) return null;
  const stackBB = Math.min(AUDIT_MAX_STACK, Math.max(2, roundTo(exactStack, 0.5)));
  const deadBB = nearest(exactDead, AUDIT_DEAD_LEVELS);
  const a = pre[heroIdx]!;
  let heroAction: GtoAction | 'other' = 'other';
  if (a.type === 'fold') heroAction = 'fold';
  else if (role === 'sbShove' && (a.type === 'raise' || a.type === 'bet') && (a.allIn || a.amount >= (sb.stack + sb.streetCommitted) * 0.9)) heroAction = 'shove';
  else if (role === 'bbCall' && a.type === 'call') heroAction = 'call';
  const heroClass = classOfCombo(cards[0]!, cards[1]!);
  const sol = solvePushFold({ stackBB, deadBB });
  const spot = { seed: 0, role, stackBB, anteFormat: 'none' as const, deadBB, heroCards: [cards[0]!, cards[1]!] as [typeof cards[0], typeof cards[1]], heroClass };
  const probe = gradeGtoSpot(spot, 'fold', sol);
  const g = heroAction === 'other' ? null : gradeGtoSpot(spot, heroAction, sol);
  return {
    role,
    stackBB,
    deadBB,
    exactStackBB: Math.round(exactStack * 100) / 100,
    exactDeadBB: Math.round(exactDead * 100) / 100,
    heroClass,
    heroCards: [...cards],
    heroAction,
    grade: g?.grade ?? null,
    evLossBB: g ? Math.round(g.evLossBB * 1000) / 1000 : null,
    frequency: probe.frequency,
    evAggressive: Math.round(probe.evAggressive * 1000) / 1000,
    bestAction: probe.bestAction,
    actionIndex: h.parsed.actions.indexOf(a),
  };
}
