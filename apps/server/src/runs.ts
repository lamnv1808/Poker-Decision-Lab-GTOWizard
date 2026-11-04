import {
  type DecisionNode,
  type HandState,
  type ModelResult,
  type PlayerAction,
  type QuestionAnswer,
  type QuestionNode,
  type RunCursor,
  type Scenario,
  IllegalActionError,
  answerQuestion,
  gradeDecision,
  gradeQuestion,
  heroAct,
  legalActions,
  evaluateModel,
  optionEv,
  publicState,
  startScenario,
  isRunout,
  applyAction,
  computePots,
} from '@pdl/core';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { currentVersion, loadVersion } from './content';
import { prisma } from './db';
import { HttpError, notFound, parse } from './http';
import { recordAttempt } from './learning';
import { markCompleted, scenarioStates, touchPlayed } from './history';
import { mixedSessionFor } from './mixed';

type Step = { nodeKey: string; kind: 'decision'; action: PlayerAction } | { nodeKey: string; kind: 'question' };

/** Rebuild a run deterministically from its recorded steps. */
export function replay(scenario: Scenario, steps: Step[]): RunCursor {
  let cursor = startScenario(scenario);
  for (const st of steps) {
    if (cursor.terminated) break;
    if (st.kind === 'decision') cursor = heroAct(scenario, cursor, st.action).cursor;
    else cursor = answerQuestion(scenario, cursor);
  }
  return cursor;
}

const modelCache = new Map<string, ModelResult | null>();
function modelFor(versionId: string, scenario: Scenario, nodeKey: string, node: DecisionNode, state: HandState): ModelResult | null {
  if (!node.model) return null;
  const sig = `${versionId}:${nodeKey}:${state.players.map((p) => `${p.stack}/${p.streetCommitted}/${p.totalCommitted}/${p.folded ? 1 : 0}`).join('|')}:${state.board.join('')}`;
  if (!modelCache.has(sig)) {
    if (modelCache.size > 500) modelCache.clear();
    modelCache.set(sig, evaluateModel(scenario, node, state));
  }
  return modelCache.get(sig)!;
}

/** Exact facts at a decision point. */
export function mathFacts(state: HandState, bb: number, action?: PlayerAction) {
  const legal = legalActions(state);
  if (!legal) return null;
  const me = state.players[state.toAct]!;
  const live = state.players.filter((p) => !p.folded && p.id !== me.id);
  const eff = Math.min(me.stack, Math.max(0, ...live.map((p) => p.stack + p.streetCommitted - me.streetCommitted)));
  const r = (x: number) => Math.round(x * 10) / 10;
  let winnable: number | null = null;
  if (legal.toCall > 0) {
    const after = applyAction(state, { type: 'call' });
    winnable = computePots(after).filter((p) => p.eligible.includes(me.id)).reduce((s, p) => s + p.amount, 0);
  }
  const facts: Record<string, number | null> = {
    potBB: r(legal.pot / bb),
    toCallBB: r(legal.toCall / bb),
    effectiveStackBB: r(eff / bb),
    // Price uses only the pot Hero can win: when Hero calls all-in for less, the excess is not winnable.
    requiredEquityPct: winnable !== null ? r((legal.callAmount / winnable) * 100) : null,
    potOddsToOne: winnable !== null ? Math.round(((winnable - legal.callAmount) / legal.callAmount) * 100) / 100 : null,
    // MDF only applies when facing a real bet (not merely the blinds preflop)
    mdfPct: legal.toCall > 0 && (state.street !== 'preflop' || state.currentBet > bb) ? r(((legal.pot - legal.toCall) / legal.pot) * 100) : null,
    spr: state.street !== 'preflop' && legal.pot > 0 ? Math.round((eff / legal.pot) * 100) / 100 : null,
    betBreakEvenPct: null,
    betPotFraction: null,
  };
  if (action && (action.type === 'bet' || action.type === 'raise') && action.amount) {
    const risk = action.amount - me.streetCommitted;
    facts.betBreakEvenPct = r((risk / (legal.pot + risk)) * 100);
    facts.betPotFraction = Math.round(((action.amount - state.currentBet) / (legal.pot + legal.toCall)) * 100) / 100;
  }
  return facts;
}

function scenarioMeta(s: Scenario, sourceClass: string) {
  return {
    id: s.id,
    version: s.version,
    mode: s.mode,
    module: s.module,
    title: s.title,
    summary: s.summary,
    format: s.format,
    difficulty: s.difficulty,
    source: { classification: sourceClass, method: s.source.method, reference: s.source.reference ?? null },
    blinds: { smallBlind: s.table.smallBlind, bigBlind: s.table.bigBlind, ante: s.table.ante, anteMode: s.table.anteMode },
    players: s.table.players.map((p) => ({ pos: p.pos, name: p.name ?? null, bounty: p.bounty ?? null, tendencies: p.tendencies ?? null })),
    heroPos: s.table.heroPos,
    tournament: s.tournament ? { payouts: s.tournament.payouts ?? null, playersLeft: s.tournament.playersLeft ?? null, note: s.tournament.note ?? null, otherStacksBB: s.tournament.otherStacksBB ?? null } : null,
  };
}

/** Hidden-information-safe run view. Never includes option grades, EVs, explanations or villain cards. */
export function runView(run: { id: string; mode: string; status: string }, versionId: string, s: Scenario, sourceClass: string, cursor: RunCursor, feedbackLog: unknown[]) {
  const node = s.nodes[cursor.nodeId];
  const hero = s.table.heroPos;
  let status: 'decision' | 'question' | 'complete' = 'complete';
  let prompt = null;
  let question = null;
  if (!cursor.terminated && node?.kind === 'decision') {
    status = 'decision';
    prompt = node.prompt ?? null;
  } else if (!cursor.terminated && node?.kind === 'question') {
    status = 'question';
    const q = node as QuestionNode;
    question = {
      type: q.questionType,
      prompt: q.prompt,
      basis: q.basis,
      choices: q.choices?.map((c) => ({ id: c.id, label: c.label })) ?? null,
      tolerance: q.tolerance,
    };
  }
  return {
    runId: run.id,
    versionId,
    mode: run.mode,
    status,
    terminated: cursor.terminated ?? null,
    nodeKey: cursor.nodeId,
    scenario: scenarioMeta(s, sourceClass),
    heroCards: s.table.heroCards,
    state: publicState(cursor.state, hero),
    legal: status === 'decision' ? legalActions(cursor.state) : null,
    runout: isRunout(cursor.state),
    prompt,
    question,
    feedback: feedbackLog,
  };
}

async function sessionFor(userId: string, kind: string, mode: string) {
  const recent = await prisma.trainingSession.findFirst({
    where: { userId, kind, mode, endedAt: null, startedAt: { gt: new Date(Date.now() - 2 * 3600 * 1000) } },
    orderBy: { startedAt: 'desc' },
  });
  return recent ?? prisma.trainingSession.create({ data: { userId, kind, mode } });
}

async function loadRun(userId: string, runId: string) {
  const run = await prisma.scenarioRun.findFirst({ where: { id: runId, userId } });
  if (!run) throw notFound('Run not found');
  const v = await loadVersion(run.scenarioVersionId);
  if (!v) throw notFound('Scenario version missing');
  const steps = run.steps as unknown as Step[];
  const feedback = await prisma.decisionAttempt.findMany({ where: { runId: run.id, userId }, orderBy: { createdAt: 'asc' }, select: { result: true } });
  return { run, v, steps, cursor: replay(v.scenario, steps), feedbackLog: feedback.map((f) => f.result) };
}

function explanationPayload(node: DecisionNode | QuestionNode) {
  return node.explanation;
}

/** Record a finished scenario in the user's history (validated result only when graded). */
async function finishRun(userId: string, runId: string, scenarioId: string, module: string) {
  const atts = await prisma.decisionAttempt.findMany({ where: { runId, userId }, select: { graded: true, isError: true, ratingApplied: true, confidence: true } });
  const graded = atts.filter((a) => a.graded);
  await markCompleted(userId, `scenario:${scenarioId}`, module, runId, {
    result: !graded.length ? 'ungraded' : graded.some((a) => a.isError) ? 'incorrect' : 'correct',
    ratingEligible: atts.some((a) => a.ratingApplied),
    confidence: atts[atts.length - 1]?.confidence ?? null,
  });
}

/** Replaying a scenario already completed is practice: it can never add rated Elo again. */
async function startRun(userId: string, scenarioId: string, requestedMode: 'practice' | 'rated', sessionId?: string) {
  const v = await currentVersion(scenarioId);
  if (!v) throw notFound('Scenario not found');
  const st = (await scenarioStates(userId, [scenarioId])).get(scenarioId)!;
  const mixed = sessionId ? await mixedSessionFor(userId, sessionId) : null;
  const wanted = mixed?.mode ?? requestedMode;
  const replay = st.timesCompleted > 0;
  const mode = replay ? 'practice' : wanted;
  const session = mixed ? { id: mixed.id } : await sessionFor(userId, v.scenario.mode, mode);
  const run = await prisma.scenarioRun.create({ data: { userId, sessionId: session.id, scenarioVersionId: v.id, mode } });
  await touchPlayed(userId, `scenario:${scenarioId}`, v.scenario.mode, run.id);
  return { v, run, replay, ratedBlocked: replay && wanted === 'rated' };
}

export const runsRouter = Router();

const ActionInput = z.object({
  type: z.enum(['fold', 'check', 'call', 'bet', 'raise']),
  amount: z.number().int().positive().optional(),
});

runsRouter.post('/', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ scenarioId: z.string().min(1), mode: z.enum(['practice', 'rated']).default('practice'), sessionId: z.string().uuid().optional() }), req.body);
  const { v, run, replay, ratedBlocked } = await startRun(userId, body.scenarioId, body.mode, body.sessionId);
  res.status(201).json({ ...runView(run, v.id, v.scenario, v.sourceClass, startScenario(v.scenario), []), replay, ratedBlocked });
});

/**
 * Pick the next scenario for the user ("next test"): due reviews first, then scenarios never
 * attempted, then any other — random within each tier, never repeating the one just played.
 */
/**
 * Pick the next scenario ("next test") from a pool. Default "new": never-played scenarios only.
 * When a pool is exhausted the response says so (409 pool_exhausted with counts) instead of
 * silently repeating content. Recently played scenarios are avoided in the broader pools.
 */
export const POOLS = ['new', 'newDue', 'all', 'played', 'bookmarked', 'weak'] as const;
const RECENT_WINDOW = 5;
export interface PickInput {
  kind: 'hero' | 'villain';
  mode: 'practice' | 'rated';
  module?: string;
  difficulty?: number;
  ratedOnly?: boolean;
  excludeScenarioId?: string;
  pool: (typeof POOLS)[number];
  sessionId?: string;
}
export type PickResult =
  | { ok: true; view: ReturnType<typeof runView> & { pickReason: string; poolSize: number; replay: boolean; ratedBlocked: boolean } }
  | { ok: false; status: 404 | 409; body: { error: string; message: string; pool?: string; counts?: Record<string, number> } };

/** Pick and start the next scenario from a pool (shared by Launcher and Mixed Training). */
export async function pickScenario(userId: string, body: PickInput): Promise<PickResult> {
  const scenarios = await prisma.scenario.findMany({ where: { published: true, mode: body.kind, module: body.module || undefined } });
  const versions = await prisma.scenarioVersion.findMany({
    where: { OR: scenarios.map((s) => ({ scenarioId: s.id, version: s.currentVersion })) },
    select: { scenarioId: true, difficulty: true, source: { select: { classification: true } } },
  });
  const filtered = versions
    .filter((v) => (body.difficulty ? v.difficulty === body.difficulty : true))
    .filter((v) => (body.ratedOnly ? ['SOLVER_VERIFIED', 'COACH_REVIEWED'].includes(v.source.classification) : true))
    .map((v) => v.scenarioId);
  if (!filtered.length) return { ok: false, status: 404, body: { error: 'no_scenarios', message: 'No scenarios match these filters' } };
  const states = await scenarioStates(userId, filtered);
  const bookmarks = new Set((await prisma.bookmark.findMany({ where: { userId, scenarioId: { in: filtered } }, select: { scenarioId: true } })).map((b) => b.scenarioId));
  const st = (id: string) => states.get(id)!;
  const recent = new Set([...filtered].filter((id) => st(id).lastPlayedAt).sort((a, b) => +st(b).lastPlayedAt! - +st(a).lastPlayedAt!).slice(0, RECENT_WINDOW));
  const inPool: Record<(typeof POOLS)[number], (id: string) => boolean> = {
    new: (id) => st(id).status === 'new',
    newDue: (id) => st(id).status === 'new' || st(id).status === 'due',
    all: () => true,
    played: (id) => st(id).timesCompleted > 0,
    bookmarked: (id) => bookmarks.has(id),
    weak: (id) => st(id).lastResult === 'incorrect' || (st(id).mastery !== null && st(id).mastery! < 0.5),
  };
  let pool = filtered.filter(inPool[body.pool]);
  if (pool.length > 1 && body.excludeScenarioId) pool = pool.filter((id) => id !== body.excludeScenarioId);
  // in repeat-capable pools, avoid the most recently played ones when there is anything else
  if (body.pool !== 'new') {
    const fresh = pool.filter((id) => !recent.has(id));
    if (fresh.length) pool = fresh;
  }
  if (!pool.length) {
    const counts = { available: filtered.length, completed: filtered.filter((id) => st(id).timesCompleted > 0).length, due: filtered.filter((id) => st(id).status === 'due').length, bookmarked: bookmarks.size };
    return { ok: false, status: 409, body: { error: 'pool_exhausted', message: 'No scenarios left in this pool', pool: body.pool, counts } };
  }
  // due first within the pool, then new, then least-recently played
  const due = pool.filter((id) => st(id).status === 'due');
  const fresh = pool.filter((id) => st(id).status === 'new');
  const tier = due.length ? due : fresh.length ? fresh : [...pool].sort((a, b) => +(st(a).lastPlayedAt ?? 0) - +(st(b).lastPlayedAt ?? 0)).slice(0, Math.max(1, Math.ceil(pool.length / 3)));
  const scenarioId = tier[Math.floor(Math.random() * tier.length)]!;
  const { v, run, replay, ratedBlocked } = await startRun(userId, scenarioId, body.mode, body.sessionId);
  const reason = tier === due ? 'due' : tier === fresh ? 'new' : 'review';
  return { ok: true, view: { ...runView(run, v.id, v.scenario, v.sourceClass, startScenario(v.scenario), []), pickReason: reason, poolSize: pool.length, replay, ratedBlocked } };
}

runsRouter.post('/next', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(
    z.object({
      kind: z.enum(['hero', 'villain']),
      mode: z.enum(['practice', 'rated']).default('practice'),
      module: z.string().max(4).optional(),
      difficulty: z.number().int().min(1).max(5).optional(),
      ratedOnly: z.boolean().default(false),
      excludeScenarioId: z.string().max(200).optional(),
      pool: z.enum(POOLS).default('new'),
      sessionId: z.string().uuid().optional(),
    }),
    req.body,
  );
  const r = await pickScenario(userId, body);
  if (!r.ok) return void res.status(r.status).json(r.body);
  res.status(201).json(r.view);
});

runsRouter.get('/:id', async (req, res) => {
  const userId = requireUser(req);
  const { run, v, cursor, feedbackLog } = await loadRun(userId, String(req.params.id));
  res.json(runView(run, v.id, v.scenario, v.sourceClass, cursor, feedbackLog));
});

/** The node (view.nodeKey) the answer belongs to. */
const NodeKey = z.string().min(1).max(200);

runsRouter.post('/:id/act', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ clientAttemptId: z.string().min(8).max(100), nodeKey: NodeKey, action: ActionInput, confidence: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }), req.body);
  const { run, v, steps, cursor } = await loadRun(userId, String(req.params.id));
  const s = v.scenario;
  const dup = await prisma.decisionAttempt.findUnique({ where: { userId_clientAttemptId: { userId, clientAttemptId: body.clientAttemptId } } });
  if (dup) {
    const again = await loadRun(userId, run.id);
    res.json({ feedback: dup.result, view: runView(again.run, v.id, s, v.sourceClass, again.cursor, again.feedbackLog) });
    return;
  }
  const node = s.nodes[cursor.nodeId];
  // only the node that was shown may be answered: a stale retry never lands on the next node
  if (body.nodeKey !== cursor.nodeId) throw new HttpError(409, 'stale_decision', 'This answer was for an earlier step; the run has moved on');
  if (cursor.terminated || !node || node.kind !== 'decision') throw new HttpError(409, 'not_at_decision', 'This run is not waiting for a decision');
  const before = cursor.state;
  let step;
  try {
    step = heroAct(s, cursor, body.action);
  } catch (e) {
    if (e instanceof IllegalActionError) throw new HttpError(400, 'illegal_action', e.message);
    throw e;
  }
  const model = modelFor(v.id, s, cursor.nodeId, node, before);
  const g = gradeDecision(s, node, step.option, model);
  const bb = s.table.bigBlind;
  const heroP = before.players[before.toAct]!;
  const facts = mathFacts(before, bb, body.action);
  const optionsReveal = node.options.map((o) => {
    const ev = optionEv(s, o, model);
    return { id: o.id, label: o.label, ev: ev ?? null, rubricGrade: ev === undefined ? (o.grade ?? null) : null, isBest: g.bestOptionIds.includes(o.id), feedback: o.feedback };
  });
  const feedback = {
    nodeKey: cursor.nodeId,
    street: before.street,
    prompt: node.prompt ?? null,
    chosen: { action: body.action, optionId: step.option?.id ?? null, label: step.option?.label ?? null, feedback: step.option?.feedback ?? null },
    graded: g.graded,
    grade: g.grade ?? null,
    basis: g.basis,
    evLoss: g.evLoss ?? null,
    unit: g.unit ?? null,
    note: g.note ?? null,
    ratingEligible: g.ratingEligible && run.mode === 'rated' && s.source.classification !== 'MATH_VERIFIED',
    options: optionsReveal,
    model: model ? { unit: model.unit, assumptions: model.assumptions, evStdErr: model.evStdErr, outcomes: model.outcomes.map((o) => ({ key: o.key, ev: o.ev, continueProb: o.continueProb ?? null, detail: o.detail })) } : null,
    facts,
    explanation: explanationPayload(node),
    source: { classification: v.sourceClass, method: s.source.method },
    concepts: node.concepts,
    skills: node.skills,
  };
  const newSteps: Step[] = [...steps, { nodeKey: cursor.nodeId, kind: 'decision', action: body.action }];
  const done = !!step.cursor.terminated || (s.nodes[step.cursor.nodeId]?.kind ?? 'end') === 'end';
  const updated = await prisma.scenarioRun.updateMany({
    where: { id: run.id, userId, steps: { equals: steps as object } },
    data: { steps: newSteps as object, status: done ? 'completed' : 'active', completedAt: done ? new Date() : null },
  });
  if (updated.count !== 1) throw new HttpError(409, 'conflict', 'Run changed concurrently; reload');
  const dbNode = await prisma.decisionNode.findUnique({ where: { scenarioVersionId_nodeKey: { scenarioVersionId: v.id, nodeKey: cursor.nodeId } } });
  const outcome = await recordAttempt({
    userId,
    clientAttemptId: body.clientAttemptId,
    sessionId: run.sessionId,
    runId: run.id,
    scenarioVersionId: v.id,
    decisionNodeId: dbNode?.id ?? null,
    attemptType: 'decision',
    itemRef: `${s.id}:${cursor.nodeId}`,
    reviewType: 'scenario',
    reviewRef: s.id,
    mode: run.mode as 'practice' | 'rated',
    action: body.action,
    optionKey: step.option?.id ?? null,
    graded: g.graded,
    grade: g.grade,
    gradeBasis: g.basis,
    evLoss: g.evLoss,
    evUnit: g.unit,
    ratingEligible: g.ratingEligible,
    isError: g.isError,
    confidence: body.confidence,
    gradingMethodVersion: g.methodVersion,
    street: before.street,
    heroPosition: heroP.id,
    effectiveStackBB: facts?.effectiveStackBB ?? undefined,
    difficulty: s.difficulty,
    skills: node.skills,
    concepts: node.concepts,
    leakOpportunities: node.leakOpportunities,
    optionLeaks: step.option?.leaks ?? [],
    sourceClass: s.source.classification,
    // Assumed-range models (MATH_VERIFIED content) are Fundamentals: they never move strategy Elo.
    track: s.source.classification === 'MATH_VERIFIED' ? 'fundamentals' : 'strategy',
    result: feedback,
  });
  if (done) await finishRun(userId, run.id, v.scenario.id, v.scenario.mode);
  const after = await loadRun(userId, run.id);
  res.json({ feedback: outcome.result, view: runView(after.run, v.id, s, v.sourceClass, after.cursor, after.feedbackLog) });
});

const AnswerInput = z.union([
  z.object({ choiceId: z.string().min(1) }),
  z.object({ value: z.number().finite() }),
  z.object({ classes: z.array(z.string().regex(/^[2-9TJQKA]{2}[so]?$/)).max(169) }),
]);

runsRouter.post('/:id/answer', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ clientAttemptId: z.string().min(8).max(100), nodeKey: NodeKey, answer: AnswerInput, confidence: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }), req.body);
  const { run, v, steps, cursor } = await loadRun(userId, String(req.params.id));
  const s = v.scenario;
  const dup = await prisma.decisionAttempt.findUnique({ where: { userId_clientAttemptId: { userId, clientAttemptId: body.clientAttemptId } } });
  if (dup) {
    const again = await loadRun(userId, run.id);
    res.json({ feedback: dup.result, view: runView(again.run, v.id, s, v.sourceClass, again.cursor, again.feedbackLog) });
    return;
  }
  const node = s.nodes[cursor.nodeId];
  // only the node that was shown may be answered: a stale retry never lands on the next node
  if (body.nodeKey !== cursor.nodeId) throw new HttpError(409, 'stale_decision', 'This answer was for an earlier step; the run has moved on');
  if (cursor.terminated || !node || node.kind !== 'question') throw new HttpError(409, 'not_at_question', 'This run is not waiting for an answer');
  let g;
  try {
    g = gradeQuestion(s, node, body.answer as QuestionAnswer, cursor.state.board.join(''));
  } catch (e) {
    throw new HttpError(400, 'invalid_answer', (e as Error).message);
  }
  const feedback = {
    nodeKey: cursor.nodeId,
    street: cursor.state.street,
    prompt: node.prompt,
    questionType: node.questionType,
    basis: node.basis,
    answer: body.answer,
    graded: g.graded,
    grade: g.grade ?? null,
    basisGrade: 'exact',
    ratingEligible: g.ratingEligible && run.mode === 'rated',
    truth: g.truth,
    choices: node.choices?.map((c) => ({ id: c.id, label: c.label, correct: c.correct, feedback: c.feedback ?? null })) ?? null,
    explanation: node.explanation,
    source: { classification: v.sourceClass, method: s.source.method },
    concepts: node.concepts,
    skills: node.skills,
  };
  const next = answerQuestion(s, cursor);
  const newSteps: Step[] = [...steps, { nodeKey: cursor.nodeId, kind: 'question' }];
  const done = !!next.terminated || s.nodes[next.nodeId]?.kind === 'end';
  const updated = await prisma.scenarioRun.updateMany({
    where: { id: run.id, userId, steps: { equals: steps as object } },
    data: { steps: newSteps as object, status: done ? 'completed' : 'active', completedAt: done ? new Date() : null },
  });
  if (updated.count !== 1) throw new HttpError(409, 'conflict', 'Run changed concurrently; reload');
  const dbNode = await prisma.decisionNode.findUnique({ where: { scenarioVersionId_nodeKey: { scenarioVersionId: v.id, nodeKey: cursor.nodeId } } });
  const outcome = await recordAttempt({
    userId,
    clientAttemptId: body.clientAttemptId,
    sessionId: run.sessionId,
    runId: run.id,
    scenarioVersionId: v.id,
    decisionNodeId: dbNode?.id ?? null,
    attemptType: 'question',
    itemRef: `${s.id}:${cursor.nodeId}`,
    reviewType: 'scenario',
    reviewRef: s.id,
    mode: run.mode as 'practice' | 'rated',
    action: body.answer,
    optionKey: 'choiceId' in body.answer ? body.answer.choiceId : null,
    graded: g.graded,
    grade: g.grade,
    gradeBasis: 'exact',
    ratingEligible: g.ratingEligible,
    isError: g.isError,
    confidence: body.confidence,
    gradingMethodVersion: g.methodVersion,
    street: cursor.state.street,
    heroPosition: s.table.heroPos,
    difficulty: s.difficulty,
    skills: node.skills,
    concepts: node.concepts,
    leakOpportunities: node.leakOpportunities,
    optionLeaks: g.isError ? node.leaksOnError : [],
    sourceClass: s.source.classification,
    track: s.source.classification === 'MATH_VERIFIED' ? 'fundamentals' : 'strategy',
    result: feedback,
  });
  if (done) await finishRun(userId, run.id, v.scenario.id, v.scenario.mode);
  const after = await loadRun(userId, run.id);
  res.json({ feedback: outcome.result, view: runView(after.run, v.id, s, v.sourceClass, after.cursor, after.feedbackLog) });
});

export const scenariosRouter = Router();
scenariosRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  const q = parse(z.object({ mode: z.enum(['hero', 'villain']).optional(), module: z.string().optional(), difficulty: z.coerce.number().int().optional() }), req.query);
  const scenarios = await prisma.scenario.findMany({ where: { published: true, mode: q.mode, module: q.module }, orderBy: [{ module: 'asc' }, { id: 'asc' }] });
  const versions = await prisma.scenarioVersion.findMany({ where: { OR: scenarios.map((s) => ({ scenarioId: s.id, version: s.currentVersion })) }, include: { source: true } });
  const bookmarks = new Set((await prisma.bookmark.findMany({ where: { userId } })).map((b) => b.scenarioId));
  const states = await scenarioStates(userId, versions.map((v) => v.scenarioId));
  const reviews = new Map((await prisma.reviewItem.findMany({ where: { userId, itemType: 'scenario' } })).map((r) => [r.itemRef, r]));
  const out = versions
    .map((v) => {
      const def = v.definition as unknown as Scenario;
      const r = reviews.get(v.scenarioId);
      return {
        id: v.scenarioId,
        mode: def.mode,
        module: def.module,
        title: def.title,
        summary: def.summary,
        format: def.format,
        difficulty: v.difficulty,
        skills: v.skills,
        concepts: v.concepts,
        classification: v.source.classification,
        rated: ['SOLVER_VERIFIED', 'COACH_REVIEWED'].includes(v.source.classification),
        bookmarked: bookmarks.has(v.scenarioId),
        attempted: (states.get(v.scenarioId)?.timesCompleted ?? 0) > 0,
        status: states.get(v.scenarioId)?.status ?? 'new',
        timesPlayed: states.get(v.scenarioId)?.timesPlayed ?? 0,
        mastery: r?.mastery ?? null,
        dueAt: r?.dueAt ?? null,
      };
    })
    .filter((x) => (q.difficulty ? x.difficulty === q.difficulty : true))
    .sort((a, b) => a.module.localeCompare(b.module) || a.difficulty - b.difficulty);
  res.json(out);
});
