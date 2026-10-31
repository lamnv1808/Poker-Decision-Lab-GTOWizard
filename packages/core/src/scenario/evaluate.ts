import type { HandState } from '../engine';
import { DEFAULT_THRESHOLDS, type Grade, gradeFromEvLoss, isError, type Thresholds, GRADING_METHOD_VERSION } from './grading';
import type { ModelResult } from './models';
import { RATED_SOURCES, type DecisionNode, type DecisionOption, type Scenario } from './schema';

export type GradeBasis = 'solverEv' | 'modelEv' | 'rubric' | 'none';

export interface DecisionGrade {
  graded: boolean;
  grade?: Grade;
  basis: GradeBasis;
  /** EV loss in `unit`; present only for EV-based grading. */
  evLoss?: number;
  unit?: 'bb' | 'icmPct';
  /** Option ids sharing the best EV (or best rubric grade). */
  bestOptionIds: string[];
  /** Whether this decision may update skill ratings. */
  ratingEligible: boolean;
  isError: boolean;
  methodVersion: string;
  /** Human-readable reason when not graded or not rating-eligible. */
  note?: 'offTree' | 'unvalidatedSource' | 'rubricOnly';
}

const RUBRIC_ORDER: Grade[] = ['excellent', 'good', 'acceptable', 'marginal', 'mistake', 'major'];

/** EV for an option, if it has a validated one. */
export function optionEv(scenario: Scenario, option: DecisionOption, model: ModelResult | null): number | undefined {
  if (scenario.source.classification === 'SOLVER_VERIFIED' && option.ev !== undefined) return option.ev;
  if (model && option.modelKey) return model.outcomes.find((o) => o.key === option.modelKey)?.ev;
  return undefined;
}

export function gradeDecision(scenario: Scenario, node: DecisionNode, option: DecisionOption | null, model: ModelResult | null): DecisionGrade {
  const base = { methodVersion: GRADING_METHOD_VERSION };
  if (!option) {
    return { ...base, graded: false, basis: 'none', bestOptionIds: bestIds(scenario, node, model), ratingEligible: false, isError: false, note: 'offTree' };
  }
  const evs = node.options.map((o) => optionEv(scenario, o, model));
  const selected = optionEv(scenario, option, model);
  const sourceRated = RATED_SOURCES.includes(scenario.source.classification);
  if (selected !== undefined && evs.some((e) => e !== undefined)) {
    const best = Math.max(...(evs.filter((e) => e !== undefined) as number[]));
    const evLoss = Math.max(0, best - selected);
    const unit = node.evUnit;
    const thresholds: Thresholds = (node.thresholds as Thresholds | undefined) ?? DEFAULT_THRESHOLDS[unit];
    const grade = gradeFromEvLoss(evLoss, thresholds);
    const basis: GradeBasis = scenario.source.classification === 'SOLVER_VERIFIED' && option.ev !== undefined ? 'solverEv' : 'modelEv';
    return {
      ...base,
      graded: true,
      grade,
      basis,
      evLoss,
      unit,
      bestOptionIds: bestIds(scenario, node, model),
      ratingEligible: sourceRated,
      isError: isError(grade),
      note: sourceRated ? undefined : 'unvalidatedSource',
    };
  }
  if (!option.grade) {
    return { ...base, graded: false, basis: 'none', bestOptionIds: bestIds(scenario, node, model), ratingEligible: false, isError: false, note: 'rubricOnly' };
  }
  // Rubric grading counts for ratings only when a human coach reviewed the scenario.
  const eligible = scenario.source.classification === 'COACH_REVIEWED';
  return {
    ...base,
    graded: true,
    grade: option.grade,
    basis: 'rubric',
    bestOptionIds: bestIds(scenario, node, model),
    ratingEligible: eligible,
    isError: isError(option.grade),
    note: eligible ? undefined : sourceRated ? 'rubricOnly' : 'unvalidatedSource',
  };
}

export function bestIds(scenario: Scenario, node: DecisionNode, model: ModelResult | null): string[] {
  const evs = node.options.map((o) => ({ id: o.id, ev: optionEv(scenario, o, model) }));
  const withEv = evs.filter((e) => e.ev !== undefined) as { id: string; ev: number }[];
  if (withEv.length > 0) {
    const best = Math.max(...withEv.map((e) => e.ev));
    return withEv.filter((e) => e.ev >= best - 1e-9).map((e) => e.id);
  }
  const graded = node.options.filter((o) => o.grade);
  if (graded.length === 0) return [];
  const top = Math.min(...graded.map((o) => RUBRIC_ORDER.indexOf(o.grade!)));
  return graded.filter((o) => RUBRIC_ORDER.indexOf(o.grade!) === top).map((o) => o.id);
}

export type { HandState };
