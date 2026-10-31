import { parseCards } from '../cards/cards';
import { classCombos, comboCount, parseRange, removeBlocked, rangeToClassWeights } from '../cards/range';
import { GRADING_METHOD_VERSION, type Grade, isError } from './grading';
import { RATED_SOURCES, type QuestionNode, type Scenario } from './schema';

export type QuestionAnswer = { choiceId: string } | { value: number } | { classes: string[] };

export interface QuestionGrade {
  graded: boolean;
  grade?: Grade;
  isError: boolean;
  ratingEligible: boolean;
  methodVersion: string;
  /** Correct answer data revealed after submission. */
  truth: { choiceIds?: string[]; value?: number; classes?: string[]; overlap?: number };
}

function deadCards(scenario: Scenario): string {
  const b = scenario.board;
  return [scenario.table.heroCards, b.flop ?? '', b.turn ?? '', b.river ?? ''].join('');
}

/** Board cards visible at the question point are supplied by caller; default = full scenario board. */
export function computedTruth(scenario: Scenario, node: QuestionNode, visibleBoard?: string): number | undefined {
  if (!node.computed) return undefined;
  const dead = parseCards(visibleBoard !== undefined ? scenario.table.heroCards + visibleBoard : deadCards(scenario));
  if (node.computed.kind === 'comboCount') return comboCount(removeBlocked(parseRange(node.computed.range), dead));
  const whole = comboCount(removeBlocked(parseRange(node.computed.whole), dead));
  const part = comboCount(removeBlocked(parseRange(node.computed.part), dead));
  if (whole === 0) throw new Error('share: whole range is empty');
  return (part / whole) * 100;
}

export function referenceClasses(node: QuestionNode): string[] {
  if (!node.referenceRange) return [];
  return [...rangeToClassWeights(parseRange(node.referenceRange))].filter(([, w]) => w >= 0.5).map(([c]) => c);
}

/** Combo-weighted Jaccard overlap between two class sets. */
export function classOverlap(a: readonly string[], b: readonly string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  let union = 0;
  for (const c of new Set([...A, ...B])) {
    const n = classCombos(c).length;
    union += n;
    if (A.has(c) && B.has(c)) inter += n;
  }
  return union === 0 ? 1 : inter / union;
}

function byLadder(x: number, ladder: number[], higherIsBetter: boolean): Grade {
  const grades: Grade[] = ['excellent', 'good', 'acceptable', 'marginal', 'mistake'];
  for (let i = 0; i < ladder.length; i++) if (higherIsBetter ? x >= ladder[i]! : x <= ladder[i]! + 1e-9) return grades[i]!;
  return 'major';
}

export function gradeQuestion(scenario: Scenario, node: QuestionNode, answer: QuestionAnswer, visibleBoard?: string): QuestionGrade {
  const rated = RATED_SOURCES.includes(scenario.source.classification);
  const verifiable = node.basis !== 'assumption' || scenario.source.classification === 'COACH_REVIEWED';
  const base = { methodVersion: GRADING_METHOD_VERSION, ratingEligible: rated && verifiable };
  switch (node.questionType) {
    case 'multipleChoice':
    case 'actionPrediction':
    case 'sizingPrediction': {
      if (!('choiceId' in answer)) throw new Error('Expected a choice');
      const choice = node.choices?.find((c) => c.id === answer.choiceId);
      if (!choice) throw new Error('Unknown choice');
      const grade: Grade = choice.grade ?? (choice.correct ? 'excellent' : 'mistake');
      return { ...base, graded: true, grade, isError: isError(grade), truth: { choiceIds: node.choices!.filter((c) => c.correct).map((c) => c.id) } };
    }
    case 'comboCount': {
      if (!('value' in answer)) throw new Error('Expected a number');
      const truth = computedTruth(scenario, node, visibleBoard)!;
      const err = Math.abs(answer.value - truth);
      const rel = truth === 0 ? err : err / truth;
      let grade: Grade;
      if (err <= node.tolerance + 1e-9) grade = 'excellent';
      else if (err <= node.tolerance + 1 + 1e-9) grade = 'good';
      else grade = byLadder(rel, [-1, -1, 0.1, 0.2, 0.4], false);
      return { ...base, graded: true, grade, isError: isError(grade), truth: { value: truth } };
    }
    case 'percentEstimate': {
      if (!('value' in answer)) throw new Error('Expected a number');
      const truth = computedTruth(scenario, node, visibleBoard)!;
      const tol = node.tolerance || 3;
      const err = Math.abs(answer.value - truth);
      const grade = byLadder(err, [tol, tol * 2, tol * 3, tol * 4, tol * 6], false);
      return { ...base, graded: true, grade, isError: isError(grade), truth: { value: truth } };
    }
    case 'rangeGrid': {
      if (!('classes' in answer)) throw new Error('Expected range classes');
      const ref = referenceClasses(node);
      const overlap = classOverlap(answer.classes, ref);
      const grade = byLadder(overlap, [0.85, 0.75, 0.65, 0.5, 0.35], true);
      return { ...base, graded: true, grade, isError: isError(grade), truth: { classes: ref, overlap } };
    }
  }
}
