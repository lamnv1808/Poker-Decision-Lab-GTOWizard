/**
 * Decision grading. Two paths, never mixed:
 *  1. EV-based: when every compared action has an EV from a validated source
 *     (a computed math model or a solver dataset), grade = f(EV loss).
 *  2. Concept-based: otherwise use the authored rubric category. No EV loss is shown.
 */
export const GRADES = ['excellent', 'good', 'acceptable', 'marginal', 'mistake', 'major'] as const;
export type Grade = (typeof GRADES)[number];

export type EvUnit = 'bb' | 'icmPct';

/** Upper bounds (inclusive) of EV loss for excellent, good, acceptable, marginal, mistake. Above => major. */
export type Thresholds = [number, number, number, number, number];

export const DEFAULT_THRESHOLDS: Record<EvUnit, Thresholds> = {
  bb: [0.05, 0.2, 0.5, 1.0, 2.5],
  // ICM losses in percent of the remaining prize pool
  icmPct: [0.02, 0.08, 0.2, 0.4, 1.0],
};

export const GRADING_METHOD_VERSION = 'grading-v1';

/** Score used for skill ratings, in [0,1]. */
export const GRADE_SCORE: Record<Grade, number> = {
  excellent: 1,
  good: 0.85,
  acceptable: 0.7,
  marginal: 0.45,
  mistake: 0.2,
  major: 0,
};

/** Whether a grade counts as an error for leak tracking and review scheduling. */
export function isError(grade: Grade): boolean {
  return grade === 'mistake' || grade === 'major';
}

export function gradeFromEvLoss(evLoss: number, thresholds: Thresholds): Grade {
  if (!(evLoss >= -1e-9)) throw new Error(`EV loss must be >= 0, got ${evLoss}`);
  for (let i = 0; i < thresholds.length; i++) if (evLoss <= thresholds[i]! + 1e-9) return GRADES[i]!;
  return 'major';
}

export function validateThresholds(t: Thresholds): void {
  for (let i = 1; i < t.length; i++) if (!(t[i]! > t[i - 1]!)) throw new Error('Thresholds must be strictly increasing');
  if (t[0] < 0) throw new Error('Thresholds must be non-negative');
}
