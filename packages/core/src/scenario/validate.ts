import { parseCards, assertDistinct } from '../cards/cards';
import { parseRange } from '../cards/range';
import { type PlayerAction, legalActions } from '../engine';
import { DEFAULT_THRESHOLDS, validateThresholds, type Thresholds } from './grading';
import { evaluateModel, type ModelResult } from './models';
import { computedTruth, referenceClasses } from './questions';
import { type RunCursor, advance, answerQuestion, heroAct, startScenario } from './runtime';
import { type DecisionNode, type DecisionOption, Scenario, type ScenarioInput } from './schema';

/**
 * Content validation workflow. A scenario may be published only if this returns no errors.
 * It replays every branch of the tree on the engine, checks every option is a legal
 * action, recomputes model EVs, and enforces source-classification rules.
 */
export interface ValidationIssue {
  level: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ValidationReport {
  id: string;
  ok: boolean;
  issues: ValidationIssue[];
  scenario?: Scenario;
  /** Model results per decision node id (cached alongside the scenario version). */
  models: Record<string, ModelResult>;
  decisionCount: number;
  questionCount: number;
}

/** A representative engine action for an option (used to walk the branch). */
export function representativeAction(scenario: Scenario, node: DecisionNode, cursor: RunCursor, option: DecisionOption): PlayerAction {
  const legal = legalActions(cursor.state);
  if (!legal) throw new Error('No legal actions at decision');
  const m = option.match;
  const bb = scenario.table.bigBlind;
  switch (m.action) {
    case 'fold':
      return { type: 'fold' };
    case 'check':
      return { type: 'check' };
    case 'call':
      return { type: 'call' };
    case 'allin':
      if (legal.canBet) return { type: 'bet', amount: legal.maxRaiseTo };
      if (legal.canRaise) return { type: 'raise', amount: legal.maxRaiseTo };
      return { type: 'call' };
    case 'raise': {
      const type = legal.canBet ? 'bet' : 'raise';
      let lo = legal.minRaiseTo;
      let hi = legal.maxRaiseTo - 1; // exclude all-in, which maps to the all-in option when present
      if (!node.options.some((o) => o.match.action === 'allin')) hi = legal.maxRaiseTo;
      if (m.minBB !== undefined) lo = Math.max(lo, Math.ceil(m.minBB * bb));
      if (m.maxBB !== undefined) hi = Math.min(hi, Math.floor(m.maxBB * bb));
      const denom = legal.pot + legal.toCall;
      if (m.minPot !== undefined) lo = Math.max(lo, Math.ceil(cursor.state.currentBet + m.minPot * denom));
      if (m.maxPot !== undefined) hi = Math.min(hi, Math.floor(cursor.state.currentBet + m.maxPot * denom));
      if (lo > hi) throw new Error(`Option "${option.id}" sizing band contains no legal amount (${lo}..${hi})`);
      return { type, amount: Math.round((lo + hi) / 2) };
    }
  }
}

export function validateScenario(input: ScenarioInput | unknown, opts: { samples?: number } = {}): ValidationReport {
  const issues: ValidationIssue[] = [];
  const models: Record<string, ModelResult> = {};
  const err = (path: string, message: string) => issues.push({ level: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ level: 'warning', path, message });
  const parsed = Scenario.safeParse(input);
  const id = (input as { id?: string })?.id ?? '(unknown)';
  if (!parsed.success) {
    for (const i of parsed.error.issues) err(i.path.join('.'), i.message);
    return { id, ok: false, issues, models, decisionCount: 0, questionCount: 0 };
  }
  const s = parsed.data;
  const cls = s.source.classification;
  let decisionCount = 0;
  let questionCount = 0;

  // Cards
  try {
    const villainCards = s.table.players.flatMap((p) => (p.cards ? parseCards(p.cards) : []));
    const board = [s.board.flop, s.board.turn, s.board.river].filter(Boolean).join('');
    assertDistinct([...parseCards(s.table.heroCards), ...parseCards(board), ...villainCards], 'scenario cards');
    if (s.board.turn && !s.board.flop) err('board', 'Turn without flop');
    if (s.board.river && !s.board.turn) err('board', 'River without turn');
  } catch (e) {
    err('cards', (e as Error).message);
  }
  if (!s.table.players.some((p) => p.pos === s.table.heroPos)) err('table.heroPos', 'Hero position has no player');
  if (s.nodes[s.root] === undefined) err('root', `Root node "${s.root}" does not exist`);
  if (cls === 'SOLVER_VERIFIED' && !s.source.reference) err('source.reference', 'Solver-verified content must cite its solver/dataset');
  if (cls === 'COACH_REVIEWED' && !s.source.reviewedBy) err('source.reviewedBy', 'Coach-reviewed content must name the reviewer');

  // Static node checks
  for (const [nid, node] of Object.entries(s.nodes)) {
    const path = `nodes.${nid}`;
    const nextIds: (string | undefined)[] = [];
    if (node.kind === 'script') nextIds.push(node.next);
    if (node.kind === 'question') nextIds.push(node.next);
    if (node.kind === 'decision') {
      nextIds.push(...node.options.map((o) => o.next));
      const ids = new Set(node.options.map((o) => o.id));
      if (ids.size !== node.options.length) err(path, 'Duplicate option ids');
      if (node.thresholds) {
        try {
          validateThresholds(node.thresholds as Thresholds);
        } catch (e) {
          err(`${path}.thresholds`, (e as Error).message);
        }
      }
      if (node.evUnit === 'icmPct' && !s.tournament?.payouts) err(path, 'icmPct grading requires tournament.payouts');
      for (const o of node.options) {
        if ((o.frequency !== undefined || o.ev !== undefined) && cls !== 'SOLVER_VERIFIED')
          err(`${path}.options.${o.id}`, 'Frequencies/EVs may only be authored for SOLVER_VERIFIED content (never fabricate solver output)');
        if (!o.modelKey && !o.grade && o.ev === undefined) err(`${path}.options.${o.id}`, 'Option needs a modelKey, a rubric grade, or solver EV');
        if (o.modelKey && !node.model) err(`${path}.options.${o.id}`, 'modelKey without a model');
        if (cls === 'MATH_VERIFIED' && !o.modelKey) warn(`${path}.options.${o.id}`, 'Option has no model EV; it will be rubric-graded and not rated');
      }
      if (cls === 'MATH_VERIFIED' && !node.model) err(path, 'MATH_VERIFIED decisions need a math model');
      if (node.model) {
        const ranges =
          node.model.type === 'shove'
            ? node.model.callers.flatMap((c) => [c.callRange, c.holdingRange].filter(Boolean) as string[])
            : node.model.type === 'call'
              ? [node.model.villainRange]
              : [node.model.villainRange, ...node.model.sizes.map((x) => x.callRange)];
        for (const r of ranges) {
          try {
            parseRange(r);
          } catch (e) {
            err(`${path}.model`, (e as Error).message);
          }
        }
      }
    }
    if (node.kind === 'question') {
      const q = node;
      if (['multipleChoice', 'actionPrediction', 'sizingPrediction'].includes(q.questionType)) {
        if (!q.choices || q.choices.length < 2) err(path, 'Choice questions need at least 2 choices');
        else if (!q.choices.some((c) => c.correct)) err(path, 'At least one choice must be correct');
      }
      if ((q.questionType === 'comboCount' || q.questionType === 'percentEstimate') && !q.computed) err(path, `${q.questionType} needs a computed answer`);
      if (q.questionType === 'comboCount' && q.computed?.kind !== 'comboCount') err(path, 'comboCount needs computed.kind=comboCount');
      if (q.questionType === 'percentEstimate' && q.computed?.kind !== 'share') err(path, 'percentEstimate needs computed.kind=share');
      if (q.questionType === 'rangeGrid') {
        if (!q.referenceRange) err(path, 'rangeGrid needs referenceRange');
        else
          try {
            if (referenceClasses(q).length === 0) err(path, 'referenceRange is empty');
          } catch (e) {
            err(path, (e as Error).message);
          }
      }
      if (cls === 'MATH_VERIFIED' && q.basis === 'assumption' && q.questionType !== 'rangeGrid')
        warn(path, 'Assumption-based question in MATH_VERIFIED content will not affect ratings');
      try {
        computedTruth(s, q);
      } catch (e) {
        err(path, (e as Error).message);
      }
    }
    for (const n of nextIds) if (n !== undefined && !s.nodes[n]) err(path, `Next node "${n}" does not exist`);
  }
  if (issues.some((i) => i.level === 'error')) return { id, ok: false, issues, scenario: s, models, decisionCount, questionCount };

  // Dynamic replay of every branch
  const visited = new Set<string>();
  const walk = (cursor: RunCursor, depth: number) => {
    if (depth > 40) {
      err('tree', 'Tree too deep (cycle?)');
      return;
    }
    visited.add(cursor.nodeId);
    if (cursor.terminated) {
      if (cursor.terminated === 'noBoard') err(`nodes.${cursor.nodeId}`, 'Branch needs a board card that is not defined');
      return;
    }
    const node = s.nodes[cursor.nodeId]!;
    if (node.kind === 'question') {
      questionCount++;
      try {
        walk(answerQuestion(s, cursor), depth + 1);
      } catch (e) {
        err(`nodes.${cursor.nodeId}`, (e as Error).message);
      }
      return;
    }
    if (node.kind !== 'decision') return;
    decisionCount++;
    if (node.model) {
      try {
        const m = evaluateModel(s, node, cursor.state, opts);
        if (m) {
          models[cursor.nodeId] = m;
          for (const o of node.options)
            if (o.modelKey && !m.outcomes.some((x) => x.key === o.modelKey)) err(`nodes.${cursor.nodeId}.options.${o.id}`, `Model has no outcome "${o.modelKey}"`);
          const t = (node.thresholds as Thresholds | undefined) ?? DEFAULT_THRESHOLDS[node.evUnit];
          if (m.evStdErr * 2 > t[0]) warn(`nodes.${cursor.nodeId}`, `Sampling error (±${m.evStdErr.toFixed(3)}) is large relative to grading thresholds`);
        }
      } catch (e) {
        err(`nodes.${cursor.nodeId}.model`, (e as Error).message);
      }
    }
    for (const o of node.options) {
      try {
        const action = representativeAction(s, node, cursor, o);
        const step = heroAct(s, cursor, action);
        if (step.option?.id !== o.id) err(`nodes.${cursor.nodeId}.options.${o.id}`, `Representative action maps to "${step.option?.id ?? 'no option'}" (overlapping bands?)`);
        if (o.next) walk(step.cursor, depth + 1);
      } catch (e) {
        err(`nodes.${cursor.nodeId}.options.${o.id}`, (e as Error).message);
      }
    }
  };
  try {
    walk(startScenario(s), 0);
  } catch (e) {
    err('root', (e as Error).message);
  }
  for (const nid of Object.keys(s.nodes)) {
    const n = s.nodes[nid]!;
    if (!visited.has(nid) && n.kind !== 'script' && n.kind !== 'end') warn(`nodes.${nid}`, 'Node is unreachable');
  }
  if (decisionCount + questionCount === 0) err('tree', 'Scenario has no decisions or questions');
  if (s.mode === 'villain' && questionCount === 0) err('mode', 'Villain-mode scenarios need questions');
  if (s.mode === 'hero' && decisionCount === 0) err('mode', 'Hero-mode scenarios need decisions');
  return { id, ok: !issues.some((i) => i.level === 'error'), issues, scenario: s, models, decisionCount, questionCount };
}

void advance;
