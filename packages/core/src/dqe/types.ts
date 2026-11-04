/**
 * Decision Quality Engine (DQE): evidence model.
 *
 * A verdict says only what its evidence supports. The six categories, strongest first:
 *  - VERIFIED_SOLVER_EV:           a validated solution with EV per action, matched to this decision's
 *                                  model (economics, players, positions, stack/ante grid, action history).
 *                                  The ONLY category that may produce an EV loss or a quality grade.
 *  - VERIFIED_REFERENCE_FREQUENCY: a validated chart with action frequencies but no EV.
 *                                  May say in range / mixed / outside range; never Mistake/Blunder.
 *  - EXACT_MATHEMATICAL_RESULT:    exact arithmetic on the visible state (pot odds, required equity).
 *                                  Facts only; it does not establish the best strategic action.
 *  - MODEL_ESTIMATE:               output of an explicitly approximate model (restricted game,
 *                                  assumed ranges). Shown with its assumptions; never a grade.
 *  - HEURISTIC_GUIDANCE:           sourced coaching text. Never a grade, never "solver".
 *  - INSUFFICIENT_EVIDENCE:        nothing applicable: Unrated, with the precise missing reference.
 */
export const EVIDENCE_CATEGORIES = [
  'VERIFIED_SOLVER_EV',
  'VERIFIED_REFERENCE_FREQUENCY',
  'EXACT_MATHEMATICAL_RESULT',
  'MODEL_ESTIMATE',
  'HEURISTIC_GUIDANCE',
  'INSUFFICIENT_EVIDENCE',
] as const;
export type EvidenceCategory = (typeof EVIDENCE_CATEGORIES)[number];

/** chip EV, ICM ($EV), PKO and cash EV are different utility functions and are never interchanged. */
export type Economics = 'chipEV' | 'ICM' | 'PKO' | 'cashEV' | 'unknown';

/** What Hero faces preflop. 'facingShove' = exactly one all-in in front of Hero, everyone else folded. */
export type PreflopNode = 'unopened' | 'limped' | 'facingOpen' | 'facing3bet' | 'facing4betPlus' | 'facingShove' | 'facingShoveMultiway';

export interface PriorAction {
  pos: string;
  action: 'fold' | 'call' | 'raise' | 'shove' | 'check';
  /** total size in BB for raises/shoves (null when not applicable) */
  toBB: number | null;
}

/** Everything the evaluator may look at. Outcomes, villain cards and later streets are never inputs. */
export interface DqeDecision {
  scenarioId: string;
  format: 'MTT' | 'SNG' | 'cash' | 'unknown';
  economics: Economics;
  tableSize: number | null;
  heroPos: string | null;
  villainPositions: string[];
  effStackBB: number | null;
  /** dead money from antes, in BB */
  deadBB: number | null;
  street: 'preflop' | 'flop' | 'turn' | 'river';
  board: string[] | null;
  node: PreflopNode | 'postflop';
  history: PriorAction[];
  /** Hero's legal action kinds at the decision */
  legalActions: string[];
  /** normalized chosen action: fold | check | call | raise | shove | limp | bet */
  chosenAction: string;
  heroClass: string | null;
  /** exact facts, when the state supports them */
  potBB?: number | null;
  toCallBB?: number | null;
  requiredEquity?: number | null;
  /** sourced coaching text for this spot, if any (curated scenarios / concepts) */
  heuristic?: { sourceId: string; locator: string; text: string } | null;
}

export type MatchStatus = 'exact' | 'grid_rounded';

/** One evidence item a source returns for a decision it applies to. */
export interface Evidence {
  category: Exclude<EvidenceCategory, 'INSUFFICIENT_EVIDENCE'>;
  sourceId: string;
  sourceVersion: string;
  checksum: string | null;
  matchStatus: MatchStatus;
  /** canonical key of the reference situation actually used (after grid rounding) */
  referenceKey: string;
  economics: Economics;
  /** action → frequency (0..1), when the source has frequencies */
  frequencies: Record<string, number> | null;
  /** action → EV in BB (relative to folding), ONLY when the source computed it */
  evByAction: Record<string, number | null> | null;
  assumptions: string[];
  /** e.g. "restricted game: no overcalls" — required for MODEL_ESTIMATE */
  approximation: string | null;
  /** extra facts the source can state exactly (e.g. required equity) */
  facts: Record<string, number | string | null>;
  /** source-specific grading hook (solver EV only) */
  grade?: SolverGrade | null;
  note?: string | null;
}

export interface SolverGrade {
  grade: 'excellent' | 'good' | 'acceptable' | 'marginal' | 'mistake' | 'major';
  evLossBB: number;
  bestAction: string;
  /** a mistake verdict that the grid rounding cannot have produced */
  robust: boolean | null;
  evLossRangeBB: [number, number] | null;
}

export type VerdictLabel =
  | 'excellent' | 'good' | 'acceptable' | 'marginal' | 'mistake' | 'major' // solver EV only
  | 'inRange' | 'mixed' | 'outsideRange' // reference frequency
  | 'modelEstimate' | 'facts' | 'coaching' | 'unrated';

export type MissingReason =
  | 'no_reference_for_node'
  | 'stack_off_grid'
  | 'economics_mismatch'
  | 'multiway_unsupported'
  | 'action_outside_model'
  | 'hand_unknown'
  | 'postflop_unsupported'
  | 'bounty_could_overturn'
  | 'table_size_unknown';

export interface DqeVerdict {
  engineVersion: string;
  scenarioId: string;
  chosenAction: string;
  category: EvidenceCategory;
  label: VerdictLabel;
  /** quality grade: VERIFIED_SOLVER_EV only */
  grade: SolverGrade['grade'] | null;
  /** EV loss in BB: VERIFIED_SOLVER_EV only */
  evLossBB: number | null;
  /** EV difference against an approximate model: MODEL_ESTIMATE only, never a grade */
  modelEvLossBB: number | null;
  bestAction: string | null;
  frequencies: Record<string, number> | null;
  evByAction: Record<string, number | null> | null;
  source: { id: string; version: string; checksum: string | null; referenceKey: string } | null;
  matchStatus: MatchStatus | null;
  confidence: 'high' | 'medium' | 'low' | null;
  economics: Economics;
  assumptions: string[];
  approximation: string | null;
  facts: Record<string, number | string | null>;
  missing: { reason: MissingReason; detail: string } | null;
  notes: string[];
}

/** A source of evidence. Pure and deterministic: same decision → same answer. */
export interface EvidenceSource {
  id: string;
  version: string;
  /** null = this source does not apply (the reason is reported if no other source applies) */
  evaluate(d: DqeDecision): { evidence: Evidence } | { missing: { reason: MissingReason; detail: string } } | null;
}
