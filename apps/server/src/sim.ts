import { randomInt } from 'node:crypto';
import {
  ARCHETYPES,
  ARCHETYPE_LABELS,
  GRADING_METHOD_VERSION,
  type HeroDecisionInfo,
  IllegalActionError,
  type PlayerAction,
  SIM_BB,
  SIM_MODEL_VERSION,
  type SimConfig,
  type SimRun,
  type SkillKey,
  isError,
  legalActions,
  publicState,
  randomSimConfig,
  runSim,
  simReview,
} from '@pdl/core';
import type { SimHand } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { prisma } from './db';
import { HttpError, notFound, parse } from './http';
import { recordAttempt } from './learning';

/**
 * Full-hand Hero simulator. The deal is derived from a server-held seed; responses only ever carry
 * the public state (Hero's cards + dealt board). Villains are heuristic models (labelled), except in
 * exact push/fold spots where solver frequencies are used.
 */
export const simRouter = Router();

interface Step {
  action: PlayerAction;
  confidence?: 1 | 2 | 3;
  reasoning?: string;
  responseMs?: number;
  clientAttemptId: string;
  attemptId?: string;
}

const steps = (h: SimHand) => (h.steps as unknown as Step[]) ?? [];
const build = (h: SimHand, s: Step[] = steps(h)) => runSim(h.seed, h.config as unknown as SimConfig, s.map((x) => x.action));

/** Math facts available to Hero at the decision (no model equity — that would hint at the answer). */
function facts(info: HeroDecisionInfo) {
  return { potBB: info.potBB, toCallBB: info.toCallBB, requiredEquity: info.requiredEquity, spr: info.spr, street: info.street };
}

function decisionsView(h: SimHand, run: SimRun) {
  const reveal = h.feedback === 'guided' || run.state.complete;
  const st = steps(h);
  return run.decisions
    .filter((d) => d.action)
    .map((d, i) => ({
      index: i,
      street: d.info.street,
      action: d.action,
      confidence: st[i]?.confidence ?? null,
      reasoning: st[i]?.reasoning ?? null,
      facts: facts(d.info),
      ...(reveal ? { modelEquity: d.info.modelEquity, solver: d.info.solver, feedback: d.feedback } : {}),
      // alternatives for the Branch Explorer — only once the hand is over
      ...(run.state.complete ? { legal: d.info.legal } : {}),
    }));
}

export function simView(h: SimHand, run: SimRun = build(h)) {
  const cfg = h.config as unknown as SimConfig;
  const hero = cfg.heroPos;
  const complete = run.state.complete;
  const current = run.awaitingHero ? run.decisions[run.decisions.length - 1]! : null;
  const review = complete ? simReview(run) : null;
  return {
    id: h.id,
    status: complete ? 'complete' : h.status,
    mode: h.mode,
    feedback: h.feedback,
    kind: h.kind,
    parentId: h.parentId,
    branchAt: h.branchAt,
    modelVersion: h.modelVersion,
    bigBlind: SIM_BB,
    config: { tableSize: cfg.tableSize, heroPos: hero, stacksBB: cfg.stacksBB, anteMode: cfg.anteMode, villains: Object.fromEntries(Object.entries(cfg.villains).map(([k, a]) => [k, { archetype: a, label: ARCHETYPE_LABELS[a] }])) },
    state: publicState(run.state, hero),
    heroCards: run.state.players.find((p) => p.id === hero)!.cards,
    legal: current ? legalActions(run.state) : null,
    progress: { street: run.state.street, decisionNumber: run.decisions.filter((d) => d.action).length + (current ? 1 : 0), complete },
    current: current ? facts(current.info) : null,
    decisions: decisionsView(h, run),
    review: review
      ? {
          timeline: review.timeline,
          showdown: review.showdown,
          netBB: review.net,
          heroNetBB: review.net[hero],
          gradedCount: review.decisions.filter((d) => d.feedback?.graded).length,
          source: {
            villains: { en: 'Villains follow heuristic archetype models (not GTO). Solver frequencies are used only in exact heads-up push/fold spots.', vi: 'Đối thủ theo mô hình tính cách heuristic (không phải GTO). Tần suất solver chỉ dùng ở spot push/fold đối đầu chính xác.' },
          },
        }
      : null,
  };
}

async function load(userId: string, id: string) {
  const h = await prisma.simHand.findFirst({ where: { id, userId } });
  if (!h) throw notFound('Hand not found');
  return h;
}

const Start = z.object({
  tableSize: z.number().int().min(2).max(9).optional(),
  stackBB: z.number().int().min(5).max(200).optional(),
  archetype: z.enum([...ARCHETYPES, 'mixed']).optional(),
  mode: z.enum(['practice', 'rated']).default('practice'),
  feedback: z.enum(['guided', 'exam']).default('guided'),
  sessionId: z.string().uuid().optional(),
});

export async function createSimHand(userId: string, o: { tableSize?: number; stackBB?: number; archetype?: (typeof ARCHETYPES)[number] | 'mixed'; mode: 'practice' | 'rated'; feedback: 'guided' | 'exam'; sessionId?: string | null }) {
  const seed = randomInt(1, 2 ** 31 - 1);
  const config = randomSimConfig(seed, { tableSize: o.tableSize, stackBB: o.stackBB, archetype: o.archetype });
  return prisma.simHand.create({ data: { userId, seed, config: config as object, modelVersion: SIM_MODEL_VERSION, mode: o.mode, feedback: o.feedback, sessionId: o.sessionId ?? null } });
}

simRouter.post('/hands', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(Start, req.body ?? {});
  if (body.sessionId && !(await prisma.trainingSession.findFirst({ where: { id: body.sessionId, userId } }))) throw notFound('Session not found');
  res.status(201).json(simView(await createSimHand(userId, body)));
});

/** Unfinished hands, for resuming on any device. */
simRouter.get('/hands/active', async (req, res) => {
  const userId = requireUser(req);
  const hands = await prisma.simHand.findMany({ where: { userId, status: 'active' }, orderBy: { updatedAt: 'desc' }, take: 10 });
  res.json(hands.map((h) => ({ id: h.id, mode: h.mode, feedback: h.feedback, kind: h.kind, decisions: steps(h).length, updatedAt: h.updatedAt, tableSize: (h.config as unknown as SimConfig).tableSize })));
});

simRouter.get('/hands/:id', async (req, res) => {
  const userId = requireUser(req);
  res.json(simView(await load(userId, String(req.params.id))));
});

const Act = z.object({
  clientAttemptId: z.string().min(8).max(100),
  action: z.object({ type: z.enum(['fold', 'check', 'call', 'bet', 'raise']), amount: z.number().int().positive().optional() }),
  confidence: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  reasoning: z.string().max(1000).optional(),
  responseMs: z.number().int().min(0).max(3_600_000).optional(),
});

simRouter.post('/hands/:id/act', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(Act, req.body);
  const h = await load(userId, String(req.params.id));
  const st = steps(h);
  if (st.some((s) => s.clientAttemptId === body.clientAttemptId)) return void res.json({ view: simView(h), duplicate: true });
  if (h.status !== 'active') throw new HttpError(409, 'not_active', 'This hand is finished');
  const before = build(h, st);
  if (!before.awaitingHero) throw new HttpError(409, 'not_awaiting', 'Hero is not to act');
  const step: Step = { action: body.action as PlayerAction, confidence: body.confidence, reasoning: body.reasoning?.trim() || undefined, responseMs: body.responseMs, clientAttemptId: body.clientAttemptId };
  let run: SimRun;
  try {
    run = build(h, [...st, step]);
  } catch (e) {
    if (e instanceof IllegalActionError) throw new HttpError(400, 'illegal_action', e.message);
    throw e;
  }
  const d = run.decisions[st.length]!;
  const fb = d.feedback!;
  // Only original hands count; replays and branches are exploration and never recorded (no double counting).
  if (h.kind === 'play' && fb.graded && fb.track) {
    const session =
      (h.sessionId && (await prisma.trainingSession.findFirst({ where: { id: h.sessionId, userId } }))) ||
      (await prisma.trainingSession.findFirst({ where: { userId, kind: 'sim', mode: h.mode, endedAt: null, startedAt: { gt: new Date(Date.now() - 2 * 3600 * 1000) } }, orderBy: { startedAt: 'desc' } })) ||
      (await prisma.trainingSession.create({ data: { userId, kind: 'sim', mode: h.mode } }));
    const solver = fb.basis === 'solverEv';
    const street = d.info.street;
    const outcome = await recordAttempt({
      userId,
      clientAttemptId: body.clientAttemptId,
      sessionId: session.id,
      attemptType: 'decision',
      itemRef: `sim:${h.id}:${st.length}`,
      familyId: `sim:${h.id}`,
      reviewType: 'quiz',
      reviewRef: 'sim',
      mode: h.mode as 'practice' | 'rated',
      action: body.action,
      optionKey: body.action.type,
      graded: true,
      grade: fb.grade,
      gradeBasis: fb.basis,
      evLoss: fb.evLossBB,
      evUnit: 'bb',
      ratingEligible: true,
      isError: isError(fb.grade!),
      confidence: body.confidence,
      gradingMethodVersion: `${GRADING_METHOD_VERSION}+${SIM_MODEL_VERSION}`,
      street,
      heroPosition: (h.config as unknown as SimConfig).heroPos,
      effectiveStackBB: d.info.solver?.stackBB,
      difficulty: solver ? (Math.abs(d.info.solver!.evAggressiveBB) < 0.3 ? 4 : Math.abs(d.info.solver!.evAggressiveBB) < 1 ? 3 : 2) : 3,
      skills: (solver ? ['preflop', 'shortStack'] : [street, 'math']) as SkillKey[],
      concepts: solver ? ['push-fold', 'full-hand'] : ['pot-odds', 'full-hand'],
      leakOpportunities: ['potOdds'],
      optionLeaks: isError(fb.grade!) ? ['potOdds'] : [],
      sourceClass: solver ? 'SOLVER_VERIFIED' : 'MATH_VERIFIED',
      track: fb.track,
      responseMs: body.responseMs,
      reasoning: step.reasoning,
      result: { kind: 'sim', handId: h.id, decision: st.length, feedback: fb, facts: facts(d.info) },
    });
    step.attemptId = outcome.attemptId;
  }
  const complete = run.state.complete;
  const updated = await prisma.simHand.updateMany({
    where: { id: h.id, userId, version: h.version },
    data: { steps: [...st, step] as object, version: { increment: 1 }, ...(complete ? { status: 'complete', completedAt: new Date() } : {}) },
  });
  if (updated.count === 0) throw new HttpError(409, 'conflict', 'The hand changed on another device; reload it');
  const fresh = await load(userId, h.id);
  const reveal = h.feedback === 'guided' || complete;
  res.json({ view: simView(fresh, run), feedback: reveal ? { ...fb, modelEquity: d.info.modelEquity, solver: d.info.solver } : null });
});

simRouter.post('/hands/:id/abandon', async (req, res) => {
  const userId = requireUser(req);
  const h = await load(userId, String(req.params.id));
  if (h.status === 'active') await prisma.simHand.update({ where: { id: h.id }, data: { status: 'abandoned' } });
  res.json({ ok: true });
});

/** Same deal, play it again (practice; not recorded). Only after the original is finished. */
simRouter.post('/hands/:id/replay', async (req, res) => {
  const userId = requireUser(req);
  const h = await load(userId, String(req.params.id));
  if (!build(h).state.complete) throw new HttpError(409, 'not_complete', 'Finish the hand first');
  const root = h.parentId ?? h.id;
  const r = await prisma.simHand.create({ data: { userId, seed: h.seed, config: h.config as object, modelVersion: h.modelVersion, mode: 'practice', feedback: 'guided', kind: 'replay', parentId: root } });
  res.status(201).json(simView(r));
});

/** Branch Explorer: take a different action at one of Hero's decisions and continue from there. */
simRouter.post('/hands/:id/branch', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ decisionIndex: z.number().int().min(0).max(50), action: Act.shape.action }), req.body);
  const h = await load(userId, String(req.params.id));
  if (!build(h).state.complete) throw new HttpError(409, 'not_complete', 'Finish the hand first');
  const st = steps(h);
  if (body.decisionIndex >= st.length) throw new HttpError(400, 'invalid_input', 'No such decision');
  const prefix: Step[] = [...st.slice(0, body.decisionIndex).map((s) => ({ action: s.action, clientAttemptId: `branch-${s.clientAttemptId}` })), { action: body.action as PlayerAction, clientAttemptId: `branch-${Date.now()}` }];
  try {
    build(h, prefix);
  } catch (e) {
    if (e instanceof IllegalActionError) throw new HttpError(400, 'illegal_action', e.message);
    throw e;
  }
  const done = build(h, prefix).state.complete;
  const r = await prisma.simHand.create({
    data: { userId, seed: h.seed, config: h.config as object, modelVersion: h.modelVersion, mode: 'practice', feedback: 'guided', kind: 'branch', parentId: h.parentId ?? h.id, branchAt: body.decisionIndex, steps: prefix as object, status: done ? 'complete' : 'active', completedAt: done ? new Date() : null },
  });
  res.status(201).json(simView(r));
});

/** The original hand with its replays and branches, for side-by-side comparison. */
simRouter.get('/hands/:id/family', async (req, res) => {
  const userId = requireUser(req);
  const h = await load(userId, String(req.params.id));
  const root = h.parentId ?? h.id;
  const hands = await prisma.simHand.findMany({ where: { userId, OR: [{ id: root }, { parentId: root }] }, orderBy: { createdAt: 'asc' } });
  res.json(
    hands.map((x) => {
      const run = build(x);
      const hero = (x.config as unknown as SimConfig).heroPos;
      return { id: x.id, kind: x.kind, branchAt: x.branchAt, complete: run.state.complete, heroNetBB: run.state.complete ? simReview(run).net[hero] : null, actions: steps(x).map((s) => s.action) };
    }),
  );
});
