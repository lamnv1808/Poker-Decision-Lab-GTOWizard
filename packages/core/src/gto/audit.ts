import { classOfCombo } from '../cards/range';
import type { ReconstructedHand } from '../hh/gg';
import { type GtoAction, type GtoRole, type GtoSpot, gradeGtoSpot } from './quiz';
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
  /**
   * The verdict at every corner of the solved grid cell that contains the exact stack/dead money
   * (stack ±0.5BB grid, neighbouring ante levels). `robust` = the observed action is a mistake at
   * every corner, i.e. the rounding cannot have produced it. Outside the grid → not robust.
   */
  robust: boolean;
  evLossRangeBB: [number, number] | null;
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
  const rb = heroAction === 'other' ? null : robustness(role, exactStack, exactDead, heroClass, heroAction);
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
    robust: rb?.robust ?? false,
    evLossRangeBB: rb?.range ?? null,
  };
}

/** Grid cell corners around an exact value (or null when the value is outside the grid). */
function bracket(x: number, levels: number[]): number[] | null {
  if (x < levels[0]! - 1e-9 || x > levels[levels.length - 1]! + 1e-9) return null;
  const lo = [...levels].reverse().find((l) => l <= x + 1e-9)!;
  const hi = levels.find((l) => l >= x - 1e-9)!;
  return lo === hi ? [lo] : [lo, hi];
}
const STACK_GRID = Array.from({ length: (AUDIT_MAX_STACK - 2) * 2 + 1 }, (_, i) => 2 + i / 2);

export function robustness(role: GtoRole, exactStack: number, exactDead: number, heroClass: string, action: GtoAction) {
  const ss = bracket(exactStack, STACK_GRID);
  const ds = bracket(exactDead, AUDIT_DEAD_LEVELS);
  if (!ss || !ds) return { robust: false, range: null as [number, number] | null, corners: 0 };
  const losses: number[] = [];
  let allMistake = true;
  for (const S of ss)
    for (const D of ds) {
      const g = gradeGtoSpot({ seed: 0, role, stackBB: S, anteFormat: 'none', deadBB: D, heroCards: [] as unknown as GtoSpot['heroCards'], heroClass } as GtoSpot, action, solvePushFold({ stackBB: S, deadBB: D }));
      losses.push(g.evLossBB);
      if (!(g.grade === 'mistake' || g.grade === 'major')) allMistake = false;
    }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return { robust: allMistake, range: [r3(Math.min(...losses)), r3(Math.max(...losses))] as [number, number], corners: losses.length };
}

/**
 * Solver verdict for a learner's answer to a real push/fold spot (Replay). Uses only the stored
 * audit facts (role, stack, dead money, hand class) and the same equilibrium as the GTO quiz.
 * Chip EV only: in a bounty (PKO) tournament an aggressive "mistake" is inconclusive (the bounty
 * adds EV to shoving/calling), while folding a chip-EV shove/call stays a verified loss.
 */
export function pushFoldChoiceVerdict(
  audit: { role: 'sbShove' | 'bbCall'; stackBB: number; deadBB: number; heroClass: string; exactStackBB?: number; exactDeadBB?: number },
  choice: 'fold' | 'aggressive' | 'other',
  formatGroup: 'PKO' | 'regular' | string | null,
) {
  const aggressive: GtoAction = audit.role === 'sbShove' ? 'shove' : 'call';
  const base = { role: audit.role, stackBB: audit.stackBB, deadBB: audit.deadBB, heroClass: audit.heroClass, unit: 'chipEV-BB' as const };
  if (choice === 'other') return { ...base, class: 'outsideModel' as const, grade: null, evLossBB: null, bestAction: null, frequency: null };
  const spot = { seed: 0, role: audit.role, stackBB: audit.stackBB, anteFormat: 'none' as const, deadBB: audit.deadBB, heroCards: [] as unknown as GtoSpot['heroCards'], heroClass: audit.heroClass };
  const g = gradeGtoSpot(spot as GtoSpot, choice === 'fold' ? 'fold' : aggressive, solvePushFold({ stackBB: audit.stackBB, deadBB: audit.deadBB }));
  const mistake = g.grade === 'mistake' || g.grade === 'major';
  // 'minor': a small chip-EV loss that the quiz does not count as a mistake (acceptable/marginal)
  // a mistake is only verified if the stack/ante rounding cannot have produced it
  const robust = mistake && audit.exactStackBB !== undefined && audit.exactDeadBB !== undefined ? robustness(audit.role, audit.exactStackBB, audit.exactDeadBB, audit.heroClass, choice === 'fold' ? 'fold' : aggressive).robust : false;
  const cls = !mistake ? (g.grade === 'excellent' || g.grade === 'good' ? 'correct' : 'minor') : choice === 'aggressive' && formatGroup === 'PKO' ? 'inconclusiveBounty' : robust ? 'verified' : 'nearThreshold';
  return { ...base, class: cls as 'correct' | 'minor' | 'verified' | 'inconclusiveBounty' | 'nearThreshold', grade: g.grade, evLossBB: Math.round(g.evLossBB * 1000) / 1000, bestAction: g.bestAction, frequency: g.frequency };
}
