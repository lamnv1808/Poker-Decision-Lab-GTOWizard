import { z } from 'zod';
import { GRADES } from './grading';

/**
 * Scenario content schema. A scenario is a versioned decision tree played on the
 * authoritative engine. Pot sizes and stacks are NEVER authored: they are derived
 * by replaying actions through the engine, so they cannot be inconsistent.
 */

export const Localized = z.object({ en: z.string().min(1), vi: z.string().min(1) });
export type Localized = z.infer<typeof Localized>;

export const SOURCE_CLASSES = ['MATH_VERIFIED', 'SOLVER_VERIFIED', 'COACH_REVIEWED', 'HEURISTIC', 'EXPERIMENTAL'] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];
/** Only these classifications may influence ratings. */
export const RATED_SOURCES: readonly SourceClass[] = ['MATH_VERIFIED', 'SOLVER_VERIFIED', 'COACH_REVIEWED'];

export const SKILLS = [
  'preflop',
  'flop',
  'turn',
  'river',
  'rangeReading',
  'math',
  'shortStack',
  'icm',
  'pko',
  'exploit',
] as const;
export type SkillKey = (typeof SKILLS)[number];

export const MODULE_IDS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];

export const LEAK_KEYS = [
  'excessivePreflopAllIns',
  'incorrect3betDefense',
  'excessiveLimpCall',
  'stackDepthAdjustments',
  'overcallingBounty',
  'potOdds',
  'comboCounting',
  'riverBluffCatching',
  'missedThinValue',
  'overbluffing',
  'underbluffing',
  'bluffSizing',
  'multiwayDiscipline',
  'icmAdjustments',
  'blockers',
  'resultOriented',
] as const;
export type LeakKey = (typeof LEAK_KEYS)[number];

const RangeText = z.string().min(1);
const Pos = z.string().min(2);

export const ScriptAction = z.object({
  pos: Pos,
  type: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allin']),
  /** Raise-to total in big blinds. */
  toBB: z.number().positive().optional(),
  /** Pot-fraction bet/raise (see sizing.potFractionTarget). */
  potFraction: z.number().positive().optional(),
});
export type ScriptAction = z.infer<typeof ScriptAction>;

export const OptionMatch = z.object({
  action: z.enum(['fold', 'check', 'call', 'raise', 'allin']),
  /** For raise: inclusive raise-to bounds in BB. */
  minBB: z.number().nonnegative().optional(),
  maxBB: z.number().positive().optional(),
  /** For raise: inclusive bounds as a pot fraction (increment / (pot + toCall)). */
  minPot: z.number().nonnegative().optional(),
  maxPot: z.number().positive().optional(),
});
export type OptionMatch = z.infer<typeof OptionMatch>;

export const DecisionOption = z.object({
  id: z.string().min(1),
  label: Localized,
  match: OptionMatch,
  /** Key of the math-model outcome this option corresponds to (fold, call, shove, check, bet:<i>). */
  modelKey: z.string().optional(),
  /** Concept-based rubric grade, used when no validated EV exists for this option. */
  grade: z.enum(GRADES).optional(),
  /** Solver-only data: frequency (0..1) and EV (BB). Rejected unless source is SOLVER_VERIFIED. */
  frequency: z.number().min(0).max(1).optional(),
  ev: z.number().optional(),
  feedback: Localized,
  /** Leaks this choice is evidence of when graded as an error. */
  leaks: z.array(z.enum(LEAK_KEYS)).default([]),
  next: z.string().optional(),
});
export type DecisionOption = z.infer<typeof DecisionOption>;

const CallerSpec = z.object({
  pos: Pos,
  /** Hands Villain can hold at this point (default: any two cards). */
  holdingRange: RangeText.optional(),
  /** Subset of holdingRange that calls Hero's shove. */
  callRange: RangeText,
  /** PKO: chip-equivalent (BB) of the bounty Hero collects if this caller busts. ChipEV only. */
  bountyBB: z.number().nonnegative().optional(),
});

export const DecisionModel = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('shove'),
    /** Players left to act, in order; at most one caller is modeled (first caller), others fold. */
    callers: z.array(CallerSpec).min(1),
  }),
  z.object({
    type: z.literal('call'),
    /** The bettor; their range when betting. Calling must close the action (all-in or river). */
    villainPos: Pos,
    villainRange: RangeText,
    /** PKO: chip-equivalent (BB) of the bounty Hero collects if Villain busts. ChipEV only. */
    bountyBB: z.number().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('riverBet'),
    villainPos: Pos,
    villainRange: RangeText,
    /** Villain's response per bet size: hands that call. Villain is assumed never to raise. */
    sizes: z.array(z.object({ potFraction: z.number().positive().optional(), allIn: z.boolean().optional(), callRange: RangeText })).min(1),
  }),
]);
export type DecisionModel = z.infer<typeof DecisionModel>;

export const Explanation = z.object({
  keyReason: Localized,
  lesson: Localized,
  gto: Localized,
  exploit: Localized,
  ranges: Localized.optional(),
  assumptions: z.array(Localized).default([]),
  commonMistakes: z.array(Localized).default([]),
});
export type Explanation = z.infer<typeof Explanation>;

export const DecisionNode = z.object({
  kind: z.literal('decision'),
  prompt: Localized.optional(),
  options: z.array(DecisionOption).min(2),
  model: DecisionModel.optional(),
  /** EV unit for grading; icmPct requires tournament.payouts. */
  evUnit: z.enum(['bb', 'icmPct']).default('bb'),
  thresholds: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]).optional(),
  skills: z.array(z.enum(SKILLS)).min(1),
  concepts: z.array(z.string()).default([]),
  /** Leaks this spot tests (counts as an opportunity whatever the answer). */
  leakOpportunities: z.array(z.enum(LEAK_KEYS)).default([]),
  explanation: Explanation,
});
export type DecisionNode = z.infer<typeof DecisionNode>;

export const ScriptNode = z.object({
  kind: z.literal('script'),
  actions: z.array(ScriptAction).default([]),
  /** Players due to act before the scripted actor, and not scripted, fold automatically. */
  autoFold: z.boolean().default(true),
  note: Localized.optional(),
  next: z.string(),
});
export type ScriptNode = z.infer<typeof ScriptNode>;

export const QuestionChoice = z.object({
  id: z.string(),
  label: Localized,
  correct: z.boolean().default(false),
  grade: z.enum(GRADES).optional(),
  feedback: Localized.optional(),
});

export const QuestionNode = z.object({
  kind: z.literal('question'),
  questionType: z.enum(['multipleChoice', 'actionPrediction', 'sizingPrediction', 'rangeGrid', 'comboCount', 'percentEstimate']),
  prompt: Localized,
  /** How the answer is established — shown to the user. */
  basis: z.enum(['observed', 'assumption', 'derived']),
  choices: z.array(QuestionChoice).optional(),
  /** rangeGrid: reference range notation (a hypothesis unless basis is derived). */
  referenceRange: RangeText.optional(),
  /** comboCount / percentEstimate computed from ranges (card removal from hero cards + board). */
  computed: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('comboCount'), range: RangeText }),
      z.object({ kind: z.literal('share'), part: RangeText, whole: RangeText }),
    ])
    .optional(),
  /** Absolute tolerance: combos for comboCount, percentage points for percentEstimate. */
  tolerance: z.number().nonnegative().default(0),
  skills: z.array(z.enum(SKILLS)).min(1),
  concepts: z.array(z.string()).default([]),
  leakOpportunities: z.array(z.enum(LEAK_KEYS)).default([]),
  leaksOnError: z.array(z.enum(LEAK_KEYS)).default([]),
  explanation: Explanation,
  next: z.string().optional(),
});
export type QuestionNode = z.infer<typeof QuestionNode>;

export const EndNode = z.object({ kind: z.literal('end'), summary: Localized.optional() });

export const ScenarioNode = z.discriminatedUnion('kind', [DecisionNode, ScriptNode, QuestionNode, EndNode]);
export type ScenarioNode = z.infer<typeof ScenarioNode>;

export const ScenarioPlayer = z.object({
  pos: Pos,
  stackBB: z.number().positive(),
  name: z.string().optional(),
  /** PKO bounty in tournament currency. */
  bounty: z.number().nonnegative().optional(),
  tendencies: Localized.optional(),
  /** Revealed only after the hand (e.g. imported showdowns). Never sent before submission. */
  cards: z.string().optional(),
});

export const Scenario = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  version: z.number().int().positive(),
  mode: z.enum(['hero', 'villain']),
  module: z.enum(MODULE_IDS),
  title: Localized,
  summary: Localized,
  format: z.object({
    game: z.enum(['MTT', 'Turbo', 'Hyper', 'PKO', 'Deepstack', 'Satellite']),
    stage: z.enum(['early', 'middle', 'bubble', 'itm', 'finalTable', 'headsUp']),
    tableSize: z.number().int().min(2).max(9),
  }),
  difficulty: z.number().int().min(1).max(5),
  source: z.object({
    classification: z.enum(SOURCE_CLASSES),
    method: Localized,
    reference: z.string().optional(),
    reviewedBy: z.string().optional(),
  }),
  table: z.object({
    bigBlind: z.number().int().positive(),
    smallBlind: z.number().int().nonnegative(),
    ante: z.number().int().nonnegative(),
    anteMode: z.enum(['none', 'each', 'bigBlind']),
    players: z.array(ScenarioPlayer).min(2),
    heroPos: Pos,
    heroCards: z.string().length(4),
  }),
  board: z.object({ flop: z.string().length(6).optional(), turn: z.string().length(2).optional(), river: z.string().length(2).optional() }).default({}),
  tournament: z
    .object({
      payouts: z.array(z.number().positive()).optional(),
      /** Stacks (BB) of players at other tables, for ICM. */
      otherStacksBB: z.array(z.number().positive()).optional(),
      playersLeft: z.number().int().positive().optional(),
      prizePoolRemaining: z.number().positive().optional(),
      note: Localized.optional(),
    })
    .optional(),
  root: z.string(),
  nodes: z.record(z.string(), ScenarioNode),
});
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioInput = z.input<typeof Scenario>;
