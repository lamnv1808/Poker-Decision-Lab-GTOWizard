import type { SkillKey, SourceClass } from '../scenario/schema';
import { type Glicko, difficultyRating, inflateRd, initialGlicko, RATING_METHOD_VERSION, weightedUpdate } from './glicko2';

export type RatingKey = SkillKey | 'overall';

/** Reliability of the answer reference, by source classification. Unvalidated sources never rate. */
export const SOURCE_RELIABILITY: Record<SourceClass, number> = {
  SOLVER_VERIFIED: 1,
  MATH_VERIFIED: 1,
  COACH_REVIEWED: 0.75,
  HEURISTIC: 0,
  EXPERIMENTAL: 0,
};

/** Familiarity discount: prior rated exposures of the same item → weight. Prevents rating farming. */
export function familiarityWeight(priorExposures: number): number {
  return [1, 0.5, 0.25][priorExposures] ?? 0;
}

export interface RatingInput {
  /** Score in [0,1] derived from the grade. */
  score: number;
  difficulty: number;
  source: SourceClass;
  priorExposures: number;
  rated: boolean;
  skills: SkillKey[];
  /** Days since each rating was last updated, for RD inflation. */
  daysSince?: Partial<Record<RatingKey, number>>;
}

export interface RatingChange {
  key: RatingKey;
  before: Glicko;
  after: Glicko;
  weight: number;
}

/**
 * Pure, reproducible rating update. Same inputs → same outputs.
 * Returns no changes for practice mode, unvalidated sources or exhausted familiarity.
 */
export function computeRatingChanges(current: Partial<Record<RatingKey, Glicko>>, input: RatingInput): { changes: RatingChange[]; weight: number; methodVersion: string } {
  const weight = input.rated ? SOURCE_RELIABILITY[input.source] * familiarityWeight(input.priorExposures) : 0;
  if (weight <= 0) return { changes: [], weight: 0, methodVersion: RATING_METHOD_VERSION };
  const opp = difficultyRating(input.difficulty);
  const keys: RatingKey[] = ['overall', ...new Set(input.skills)];
  const changes = keys.map((key) => {
    const before = current[key] ?? initialGlicko();
    const inflated = inflateRd(before, input.daysSince?.[key] ?? 0);
    const after = weightedUpdate(inflated, opp, input.score, weight);
    return { key, before, after, weight };
  });
  return { changes, weight, methodVersion: RATING_METHOD_VERSION };
}
