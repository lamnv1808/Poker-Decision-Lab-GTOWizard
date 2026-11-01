import type { HandState, LegalActions, PlayerAction } from '@pdl/core/engine';

export type Lang = 'en' | 'vi';
export type Localized = { en: string; vi: string };
export type Grade = 'excellent' | 'good' | 'acceptable' | 'marginal' | 'mistake' | 'major';

export interface Preferences {
  language: Lang;
  defaultMode: 'practice' | 'rated';
  explanationView: 'quick' | 'deep';
  strategyView: 'gto' | 'exploit';
  showBB: boolean;
}
export interface Me {
  id: string;
  email: string;
  displayName: string;
  preferences: Preferences;
}

export interface Explanation {
  keyReason: Localized;
  lesson: Localized;
  gto: Localized;
  exploit: Localized;
  ranges?: Localized;
  assumptions: Localized[];
  commonMistakes: Localized[];
}

export interface DecisionFeedback {
  nodeKey: string;
  street: string;
  prompt: Localized | null;
  chosen: { action: PlayerAction; optionId: string | null; label: Localized | null; feedback: Localized | null };
  graded: boolean;
  grade: Grade | null;
  basis: 'solverEv' | 'modelEv' | 'rubric' | 'none';
  evLoss: number | null;
  unit: 'bb' | 'icmPct' | null;
  note: 'offTree' | 'unvalidatedSource' | 'rubricOnly' | 'withinSamplingError' | null;
  ratingEligible: boolean;
  options: { id: string; label: Localized; ev: number | null; rubricGrade: Grade | null; isBest: boolean; feedback: Localized }[];
  model: { unit: string; assumptions: string[]; evStdErr: number; outcomes: { key: string; ev: number; continueProb: number | null; detail: Record<string, number | string> }[] } | null;
  facts: Record<string, number | null> | null;
  explanation: Explanation;
  source: { classification: string; method: Localized };
  concepts: string[];
  ratingChanges?: { skill: string; before: number; after: number; rdAfter: number }[];
  review?: { dueAt: string; mastery: number } | null;
}

export interface QuestionFeedback {
  nodeKey: string;
  street: string;
  prompt: Localized;
  questionType: string;
  basis: 'observed' | 'assumption' | 'derived';
  answer: unknown;
  graded: boolean;
  grade: Grade | null;
  ratingEligible: boolean;
  truth: { choiceIds?: string[]; value?: number; classes?: string[]; overlap?: number };
  choices: { id: string; label: Localized; correct: boolean; feedback: Localized | null }[] | null;
  explanation: Explanation;
  source: { classification: string; method: Localized };
  ratingChanges?: { skill: string; before: number; after: number; rdAfter: number }[];
}

export interface ScenarioMeta {
  id: string;
  version: number;
  mode: 'hero' | 'villain';
  module: string;
  title: Localized;
  summary: Localized;
  format: { game: string; stage: string; tableSize: number };
  difficulty: number;
  source: { classification: string; method: Localized; reference: string | null };
  blinds: { smallBlind: number; bigBlind: number; ante: number; anteMode: string };
  players: { pos: string; name: string | null; bounty: number | null; tendencies: Localized | null }[];
  heroPos: string;
  tournament: { payouts: number[] | null; playersLeft: number | null; note: Localized | null; otherStacksBB: number[] | null } | null;
}

export interface RunView {
  runId: string;
  mode: 'practice' | 'rated';
  status: 'decision' | 'question' | 'complete';
  terminated: 'end' | 'offTree' | 'noBoard' | null;
  nodeKey: string;
  scenario: ScenarioMeta;
  heroCards: string;
  state: HandState;
  legal: LegalActions | null;
  runout: boolean;
  prompt: Localized | null;
  question: { type: string; prompt: Localized; basis: string; choices: { id: string; label: Localized }[] | null; tolerance: number } | null;
  feedback: (DecisionFeedback | QuestionFeedback)[];
}

export interface ScenarioCard {
  id: string;
  mode: 'hero' | 'villain';
  module: string;
  title: Localized;
  summary: Localized;
  format: { game: string; stage: string; tableSize: number };
  difficulty: number;
  skills: string[];
  classification: string;
  rated: boolean;
  bookmarked: boolean;
  attempted: boolean;
  mastery: number | null;
  dueAt: string | null;
}
