/**
 * Presentation adapter between the grading engine's decision feedback and the post-decision UI.
 *
 * It never computes poker numbers. It only decides which fields the engine actually supports for
 * this decision and how strong the evidence behind them is, so the UI cannot show a recommendation,
 * score or EV that the engine did not produce.
 */
import type { FeedbackView } from './components/DecisionFeedback';
import type { Grade, Lang, Localized } from './types';

export type QualityLabel = 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder' | 'limited';
/** solver = exact solver EV; reference = reviewed reference range; math = computed model EV under stated assumptions; heuristic = coaching rule; insufficient = not evaluated. */
export type EvidenceLevel = 'solver' | 'reference' | 'math' | 'heuristic' | 'insufficient';
export type NextActionType = 'nextDecision' | 'nextHand' | 'nextScenario' | 'finishSession';
export type AnalysisSection = 'why' | 'reasoning' | 'context' | 'odds' | 'comparison' | 'evidence' | 'review';
export type Assessment = 'solverVerified' | 'mathVerified' | 'reviewedStrategy' | 'assumedRange' | 'heuristicCoaching' | 'notEvaluated';

export interface EngineFeedback extends FeedbackView {
  assessment?: Assessment;
  basis?: 'solverEv' | 'modelEv' | 'none';
}

export interface DecisionFacts { potBB?: number; toCallBB?: number; requiredEquity?: number | null; spr?: number | null; street?: string }

export interface QuickFeedbackModel {
  selectedAction: string;
  /** only when the decision was graded on EV evidence (solver or computed model) */
  recommendedAction?: string;
  qualityLabel: QualityLabel;
  /** the raw engine grade, when graded */
  grade?: Grade;
  /**
   * 0–100 decision score. The engine does not compute one per decision (GRADE_SCORE is a coarse
   * rating weight, not a decision score), so this stays undefined and is never shown.
   */
  score?: number;
  /** EV difference in BB, only when graded and the engine reported a loss */
  evLossBB?: number;
  evidenceLevel: EvidenceLevel;
  shortExplanation: string;
  detailedExplanation?: string;
  availableAnalysis: AnalysisSection[];
  handComplete: boolean;
  sessionComplete: boolean;
  nextActionType: NextActionType;
}

const QUALITY: Record<Grade, QualityLabel> = {
  excellent: 'excellent',
  good: 'good',
  acceptable: 'good',
  marginal: 'inaccuracy',
  mistake: 'mistake',
  major: 'blunder',
};

const pick = (l: Localized | null | undefined, lang: Lang) => (l ? (l[lang] || l.en || '') : '');

/** Ungraded output is never given a quality label, whatever the tier says. */
export function qualityLabel(fb: Pick<FeedbackView, 'graded' | 'grade'>): QualityLabel {
  return fb.graded && fb.grade ? QUALITY[fb.grade] : 'limited';
}

/** Evidence behind this feedback. Heuristic or ungraded output is never reported as solver. */
export function evidenceLevel(fb: Pick<EngineFeedback, 'graded' | 'tier' | 'assessment' | 'basis'>): EvidenceLevel {
  switch (fb.assessment) {
    case 'solverVerified':
      return fb.graded && fb.basis !== 'modelEv' ? 'solver' : 'insufficient';
    case 'reviewedStrategy':
      return 'reference';
    case 'mathVerified':
    case 'assumedRange':
      return fb.graded ? 'math' : 'insufficient';
    case 'heuristicCoaching':
      return 'heuristic';
    case 'notEvaluated':
      return 'insufficient';
  }
  if (!fb.graded) return 'insufficient';
  if (fb.basis === 'solverEv' || fb.tier === 'solver') return 'solver';
  if (fb.basis === 'modelEv' || fb.tier === 'model') return 'math';
  return 'heuristic';
}

export function nextActionType(o: { handComplete: boolean; inSession: boolean; sessionComplete: boolean; fullHand: boolean }): NextActionType {
  if (!o.handComplete) return 'nextDecision';
  if (o.sessionComplete) return 'finishSession';
  if (o.inSession) return 'nextScenario';
  return o.fullHand ? 'nextHand' : 'nextScenario';
}

export function toQuickFeedback(
  fb: EngineFeedback | null,
  o: { selectedAction: string; lang: Lang; handComplete: boolean; inSession?: boolean; sessionComplete?: boolean; fullHand?: boolean; facts?: DecisionFacts | null; hasModelEquity?: boolean },
): QuickFeedbackModel {
  const inSession = !!o.inSession;
  const sessionComplete = !!o.sessionComplete;
  const next = nextActionType({ handComplete: o.handComplete, inSession, sessionComplete, fullHand: o.fullHand ?? true });
  if (!fb) {
    return { selectedAction: o.selectedAction, qualityLabel: 'limited', evidenceLevel: 'insufficient', shortExplanation: '', availableAnalysis: o.handComplete ? ['review'] : [], handComplete: o.handComplete, sessionComplete, nextActionType: next };
  }
  const quality = qualityLabel(fb);
  const evidence = evidenceLevel(fb);
  const evBacked = quality !== 'limited' && (evidence === 'solver' || evidence === 'math' || evidence === 'reference');
  const why = pick(fb.explain?.why, o.lang);
  const shortExplanation = evBacked && why ? why : pick(fb.limitation, o.lang) || pick(fb.coaching, o.lang) || pick(fb.note, o.lang) || why;
  const sections: AnalysisSection[] = [];
  if (why || fb.limitation || fb.coaching) sections.push('why');
  if (fb.reasoning && fb.reasoning.quality !== 'notAssessed' && fb.reasoning.checks.length) sections.push('reasoning');
  const f = o.facts;
  if (f && (f.potBB !== undefined || f.spr != null || f.street)) sections.push('context');
  if ((f && f.requiredEquity != null) || o.hasModelEquity || fb.model) sections.push('odds');
  if (fb.model?.options.length || (fb.evByAction && Object.keys(fb.evByAction).length)) sections.push('comparison');
  sections.push('evidence');
  if (o.handComplete) sections.push('review');
  return {
    selectedAction: o.selectedAction,
    recommendedAction: evBacked ? pick(fb.explain?.recommended, o.lang) || undefined : undefined,
    qualityLabel: quality,
    grade: fb.graded ? fb.grade : undefined,
    evLossBB: evBacked && fb.evLossBB !== undefined && fb.evLossBB > 0 ? fb.evLossBB : undefined,
    evidenceLevel: evidence,
    shortExplanation,
    detailedExplanation: pick(fb.note, o.lang) || undefined,
    availableAnalysis: sections,
    handComplete: o.handComplete,
    sessionComplete,
    nextActionType: next,
  };
}
