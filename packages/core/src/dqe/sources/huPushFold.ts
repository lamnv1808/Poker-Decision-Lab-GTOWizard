import { AUDIT_DEAD_LEVELS, AUDIT_MAX_STACK, robustness } from '../../gto/audit';
import { PUSHFOLD_DATA_INFO } from '../../gto';
import { PUSHFOLD_METHOD_VERSION, solvePushFold } from '../../gto/pushfold';
import { gradeGtoSpot, type GtoRole, type GtoSpot } from '../../gto/quiz';
import { checksumNumbers } from '../checksum';
import type { DqeDecision, EvidenceSource } from '../types';

/**
 * Heads-up push/fold equilibrium (chip EV) as a VERIFIED_SOLVER_EV source.
 *
 * Applies exactly where the existing push/fold audit applies (same roles, same stack/ante grid
 * rounding, same grade and robustness rules), so verified spots keep their current grading semantics:
 *  - folded to Hero in the SB (shove or fold), or Hero in the BB facing an SB all-in after everyone
 *    else folded — the subgame is heads-up at any table size;
 *  - effective stack 1–15.25 BB, rounded to the 0.5 BB grid (2–15); antes to the nearest solved level.
 * PKO: the bounty only adds EV to shoving/calling, so a chip-EV +EV shove/call that Hero folded is still
 * a verified loss, while an aggressive chip-EV "mistake" is not graded (the bounty could overturn it).
 */
export const HU_PUSHFOLD_SOURCE_ID = 'pdl-pushfold-hu';

const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const nearest = (x: number, levels: number[]) => levels.reduce((a, b) => (Math.abs(b - x) < Math.abs(a - x) ? b : a));

export function huRole(d: DqeDecision): GtoRole | null {
  if (d.street !== 'preflop') return null;
  const others = d.history;
  if (d.heroPos === 'SB' && d.node === 'unopened' && others.every((a) => a.action === 'fold')) return 'sbShove';
  if (d.heroPos === 'BB' && d.node === 'facingShove') {
    const active = others.filter((a) => a.action !== 'fold');
    if (active.length === 1 && active[0]!.pos === 'SB' && active[0]!.action === 'shove') return 'bbCall';
  }
  return null;
}

export const huPushFoldSource: EvidenceSource = {
  id: HU_PUSHFOLD_SOURCE_ID,
  version: PUSHFOLD_METHOD_VERSION,
  evaluate(d) {
    const role = huRole(d);
    if (!role) return null;
    if (d.economics !== 'chipEV' && d.economics !== 'PKO') return { missing: { reason: 'economics_mismatch', detail: `heads-up push/fold data is chip EV; this spot is ${d.economics}` } };
    if (!d.heroClass) return { missing: { reason: 'hand_unknown', detail: 'hero hand class unknown' } };
    const S = d.effStackBB;
    const D = d.deadBB;
    if (S == null || D == null || S > AUDIT_MAX_STACK + 0.25 || S < 1) return { missing: { reason: 'stack_off_grid', detail: `heads-up push/fold grid covers 2–${AUDIT_MAX_STACK} BB; this spot is ${S ?? '?'} BB` } };
    const stackBB = Math.min(AUDIT_MAX_STACK, Math.max(2, roundTo(S, 0.5)));
    const deadBB = nearest(D, AUDIT_DEAD_LEVELS);
    const sol = solvePushFold({ stackBB, deadBB });
    const aggressive = role === 'sbShove' ? 'shove' : 'call';
    const spot = { seed: 0, role, stackBB, anteFormat: 'none', deadBB, heroCards: [] as unknown as GtoSpot['heroCards'], heroClass: d.heroClass } as GtoSpot;
    const probe = gradeGtoSpot(spot, 'fold', sol);
    const chosen = d.chosenAction === 'fold' ? 'fold' : d.chosenAction === aggressive ? aggressive : null;
    const g = chosen ? gradeGtoSpot(spot, chosen, sol) : null;
    const exact = Math.abs(stackBB - S) < 1e-9 && Math.abs(deadBB - D) < 1e-9;
    const isMistake = !!g && (g.grade === 'mistake' || g.grade === 'major');
    if (g && isMistake && d.economics === 'PKO' && chosen !== 'fold')
      return { missing: { reason: 'bounty_could_overturn', detail: 'chip EV says fold, but the bounty adds EV to the aggressive action; PKO bounty EV is not modelled' } };
    const rb = g && isMistake ? robustness(role, S, D, d.heroClass, chosen!) : null;
    const assumptions = [
      'Heads-up subgame: everyone else has folded (exact at any table size).',
      'Push/fold model: SB shoves or folds; BB calls or folds (no limps or small raises).',
      'Chip EV; dead antes in the pot; equal effective stacks.',
      `Equities: ${PUSHFOLD_DATA_INFO.equityMethod}.`,
    ];
    if (d.economics === 'PKO') assumptions.push('PKO: bounty not modelled; chip EV is a lower bound for shoving/calling.');
    return {
      evidence: {
        category: 'VERIFIED_SOLVER_EV',
        sourceId: HU_PUSHFOLD_SOURCE_ID,
        sourceVersion: PUSHFOLD_METHOD_VERSION,
        checksum: checksumNumbers(sol.push, sol.call),
        matchStatus: exact ? 'exact' : 'grid_rounded',
        referenceKey: `MTT|chipEV|HU|${role}|S=${stackBB}|D=${deadBB}`,
        economics: d.economics,
        frequencies: { [aggressive]: probe.frequency, fold: Math.round((1 - probe.frequency) * 1000) / 1000 },
        evByAction: { [aggressive]: Math.round(probe.evAggressive * 1000) / 1000, fold: 0 },
        assumptions,
        approximation: null,
        facts: { exactStackBB: Math.round(S * 100) / 100, exactDeadBB: Math.round(D * 100) / 100, maxExploitabilityBB: PUSHFOLD_DATA_INFO.maxExploitabilityBB },
        grade: g ? { grade: g.grade, evLossBB: Math.round(g.evLossBB * 1000) / 1000, bestAction: g.bestAction, robust: rb ? rb.robust : null, evLossRangeBB: rb?.range ?? null } : null,
        note: exact ? null : `stack ${S} BB → ${stackBB} BB, antes ${D} → ${deadBB} BB (nearest solved grid point)`,
      },
    };
  },
};
