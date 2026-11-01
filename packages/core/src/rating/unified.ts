import { type Glicko, confidenceHalfWidth, difficultyRating, inflateRd, initialGlicko, weightedUpdate } from './glicko2';
import { familiarityWeight } from './service';

/**
 * Unified competency model (V3).
 *  - Strategy subrating: the existing `overall` Glicko rating, moved only by solver-backed or
 *    verified-annotation decisions (unchanged — no reset).
 *  - Fundamentals subrating: a separate Glicko rating (`fundamentals`) moved by exact maths
 *    exercises and model-EV decisions (MATH_VERIFIED / assumed-range sources).
 *  - Exploratory (heuristic) content is never rated.
 *  - Overall proficiency blends the two by evidence, and says "not enough evidence" when it lacks it.
 */
export const RATING_MODEL_VERSION = 'unified-v1';
export const FUNDAMENTALS_KEY = 'fundamentals';
export const FUND_METHOD_VERSION = 'fund-glicko2-v1';

export interface FundInput {
  score: number;
  difficulty: number;
  priorExposures: number;
  daysSince: number;
}

/** One Fundamentals update. Returns null when familiarity has exhausted the item. */
export function fundamentalsUpdate(current: Glicko | undefined, input: FundInput): { before: Glicko; after: Glicko; weight: number } | null {
  const weight = familiarityWeight(input.priorExposures);
  if (weight <= 0) return null;
  const before = current ?? initialGlicko();
  const after = weightedUpdate(inflateRd(before, input.daysSince), difficultyRating(input.difficulty), input.score, weight);
  return { before, after, weight };
}

export interface SubRating {
  rating: number;
  rd: number;
  games: number;
}

/** Evidence needed before a subrating contributes to overall proficiency. */
export const MIN_GAMES = 10;
export const MAX_RD = 200;
/** Strategy carries more weight than arithmetic when both are well measured. */
export const BLEND_WEIGHTS = { strategy: 0.65, fundamentals: 0.35 };

const evidence = (s: SubRating | undefined) => (s && s.games >= MIN_GAMES && s.rd <= MAX_RD ? Math.min(1, (MAX_RD + 50 - s.rd) / 200) : 0);

export interface Proficiency {
  modelVersion: string;
  status: 'ok' | 'insufficient';
  rating: number | null;
  interval95: number | null;
  confidence: 'low' | 'medium' | 'high' | null;
  /** Share of the curriculum's skill areas with rated evidence, 0–100. */
  coveragePct: number;
  components: { strategy: number; fundamentals: number };
  reason?: string;
}

/**
 * Overall proficiency: evidence-weighted blend of the two subratings. A subrating needs at least
 * MIN_GAMES rated decisions and RD ≤ MAX_RD to count; with neither, the result is "insufficient".
 */
export function overallProficiency(strategy: SubRating | undefined, fundamentals: SubRating | undefined, coverage: { covered: number; total: number }): Proficiency {
  const es = evidence(strategy) * BLEND_WEIGHTS.strategy;
  const ef = evidence(fundamentals) * BLEND_WEIGHTS.fundamentals;
  const coveragePct = coverage.total ? Math.round((100 * coverage.covered) / coverage.total) : 0;
  if (es + ef === 0)
    return { modelVersion: RATING_MODEL_VERSION, status: 'insufficient', rating: null, interval95: null, confidence: null, coveragePct, components: { strategy: 0, fundamentals: 0 }, reason: `needs ${MIN_GAMES}+ rated decisions in at least one track` };
  const ws = es / (es + ef);
  const wf = ef / (es + ef);
  const rating = ws * (strategy?.rating ?? 0) + wf * (fundamentals?.rating ?? 0);
  // RD of a weighted combination of independent estimates
  const rd = Math.sqrt(ws * ws * (strategy?.rd ?? 0) ** 2 + wf * wf * (fundamentals?.rd ?? 0) ** 2);
  const confidence = rd < 90 && coveragePct >= 50 && ws > 0 ? 'high' : rd < 140 && coveragePct >= 25 ? 'medium' : 'low';
  return {
    modelVersion: RATING_MODEL_VERSION,
    status: 'ok',
    rating: Math.round(rating),
    interval95: Math.round(confidenceHalfWidth(rd)),
    confidence,
    coveragePct,
    components: { strategy: Math.round(ws * 100) / 100, fundamentals: Math.round(wf * 100) / 100 },
  };
}

/**
 * Strongest / weakest skills without overlap. Needs at least `min` reliable skills; with fewer,
 * both lists are empty and the caller shows "not enough evidence".
 */
export function strengthsAndWeaknesses<T extends { rating: number }>(reliable: T[], k = 3, min = 2): { strengths: T[]; weaknesses: T[]; enough: boolean } {
  if (reliable.length < min) return { strengths: [], weaknesses: [], enough: false };
  const sorted = [...reliable].sort((a, b) => b.rating - a.rating);
  const n = Math.min(k, Math.floor(sorted.length / 2));
  return { strengths: sorted.slice(0, n), weaknesses: sorted.slice(-n).reverse(), enough: true };
}
