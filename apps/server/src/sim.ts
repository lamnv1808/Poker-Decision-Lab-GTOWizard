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
  type SimDeal,
  type SpotOracle,
  type Scenario,
  scenarioContinuation,
  simHiddenInfo,
  type SimRun,
  dealSimSecure,
  type SkillKey,
  classOfCombo,
  simExactKey,
  simFingerprint,
  type LeakKey,
  isError,
  legalActions,
  publicState,
  randomSimConfig,
  runSim,
  simReview,
} from '@pdl/core';
import type { Prisma, SimHand } from '@prisma/client';
import { mixedSessionFor } from './mixed';
import { markCompleted, touchPlayed } from './history';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { prisma } from './db';
import { HttpError, notFound, parse } from './http';
import { recordAttempt } from './learning';
import { postflopOracle, solverFlopHand } from './postflop';
import { loadVersion } from './content';
import { replay as replayScenario } from './runs';

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
/** How a hand was created; replays and branches copy it (branches may add Villain overrides). */
export interface Origin {
  kind: 'random' | 'scenario' | 'solverFlop';
  scenarioId?: string;
  runId?: string;
  flop?: string;
  prefix?: { playerId: string; action: PlayerAction }[];
  villainOverrides?: Record<number, 'fold' | 'passive' | 'aggressive'>;
}
const oracleFor = (o: Origin): SpotOracle | undefined => (o.kind === 'solverFlop' && o.flop ? postflopOracle(o.flop) : undefined);
const originOf = (h: SimHand) => ((h.origin as unknown as Origin | null) ?? { kind: 'random' }) as Origin;
const build = (h: SimHand, s: Step[] = steps(h)) => {
  const o = originOf(h);
  return runSim(h.seed, h.config as unknown as SimConfig, s.map((x) => x.action), {
    deal: (h.deal as unknown as SimDeal | null) ?? undefined,
    prefix: o.prefix,
    villainOverrides: o.villainOverrides,
    oracle: oracleFor(o),
  });
};

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
      ...(reveal ? { modelEquity: d.info.modelEquity, solver: d.info.solver, oracle: d.info.oracle ?? null, topics: d.info.topics, feedback: d.feedback } : {}),
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
    bigBlind: run.state.config.bigBlind,
    origin: { kind: originOf(h).kind, scenarioId: originOf(h).scenarioId ?? null, flop: originOf(h).flop ?? null },
    bookmarked: h.bookmarked,
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
          winners: review.winners,
          pots: review.pots,
          endedBy: review.endedBy,
          terminalStreet: review.terminalStreet,
          gradedCount: review.decisions.filter((d) => d.feedback?.graded).length,
          source: {
            villains: { en: 'Villains follow heuristic archetype models (not GTO). Solver frequencies are used only where a solved spot exactly matches the hand (heads-up push/fold, and the postflop library\'s flop decisions).', vi: 'Đối thủ theo mô hình tính cách heuristic (không phải GTO). Tần suất solver chỉ dùng khi spot đã giải khớp chính xác (push/fold đối đầu, và quyết định flop trong thư viện postflop).' },
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
  table: z.enum(['random', 'solverFlop']).default('random'),
  heroPos: z.enum(['BTN', 'BB']).optional(),
  tableSize: z.number().int().min(2).max(9).optional(),
  stackBB: z.number().int().min(5).max(200).optional(),
  archetype: z.enum([...ARCHETYPES, 'mixed']).optional(),
  mode: z.enum(['practice', 'rated']).default('practice'),
  feedback: z.enum(['guided', 'exam']).default('guided'),
  sessionId: z.string().uuid().optional(),
});

export async function createSimHand(
  userId: string,
  o: { table?: 'random' | 'solverFlop'; heroPos?: 'BTN' | 'BB'; tableSize?: number; stackBB?: number; archetype?: (typeof ARCHETYPES)[number] | 'mixed'; mode: 'practice' | 'rated'; feedback: 'guided' | 'exam'; sessionId?: string | null },
  db: Prisma.TransactionClient = prisma,
) {
  // Security: the table config is public, so it comes from its own random value; the cards are
  // shuffled with a CSPRNG and stored server-side. Neither can be derived from what the client sees.
  // Hands that would be over before Hero acts (e.g. a walk in the big blind) are re-dealt.
  const fresh = (): { seed: number; config: SimConfig; deal: SimDeal; origin: Origin; originKey: string } => {
    if (o.table === 'solverFlop') {
      // exact postflop-library spot: scripted preflop (folds to BTN 2.2BB, BB calls), solved flop
      const x = solverFlopHand((n) => randomInt(n), o.heroPos);
      return { seed: randomInt(1, 2 ** 31 - 1), config: x.config, deal: x.deal, origin: { kind: 'solverFlop', flop: x.flop, prefix: x.prefix }, originKey: `solverFlop:${x.flop}` };
    }
    const config = randomSimConfig(randomInt(1, 2 ** 31 - 1), { tableSize: o.tableSize, stackBB: o.stackBB, archetype: o.archetype });
    return { seed: randomInt(1, 2 ** 31 - 1), config, deal: dealSimSecure(config, (n) => randomInt(n)), origin: { kind: 'random' }, originKey: 'random' };
  };
  // Diversity: never an exact repeat; avoid the same strategic situation as any of the user's last
  // RECENT_SITUATIONS hands while alternatives exist (bounded retries, then accept the best found).
  const recent = new Set((await db.simHand.findMany({ where: { userId, kind: 'play' }, orderBy: { createdAt: 'desc' }, take: RECENT_SITUATIONS, select: { fingerprint: true } })).map((x) => x.fingerprint));
  let best: (ReturnType<typeof fresh> & { fp: string; key: string }) | null = null;
  for (let tries = 0; tries < MAX_DEAL_TRIES; tries++) {
    const h = fresh();
    if (!runSim(h.seed, h.config, [], { equitySamples: 50, deal: h.deal, prefix: h.origin.prefix, oracle: oracleFor(h.origin) }).awaitingHero) continue;
    const c = { ...h, fp: simFingerprint(h.config, h.deal, h.originKey), key: simExactKey(h.config, h.deal) };
    if (await db.simHand.findFirst({ where: { userId, exactKey: c.key }, select: { id: true } })) continue;
    best = c;
    if (!recent.has(c.fp)) break;
  }
  if (!best) {
    const h = fresh();
    best = { ...h, fp: simFingerprint(h.config, h.deal, h.originKey), key: simExactKey(h.config, h.deal) };
  }
  const created = await db.simHand.create({
    data: { userId, seed: best.seed, deal: best.deal as object, config: best.config as object, fingerprint: best.fp, exactKey: best.key, origin: best.origin as object, modelVersion: SIM_MODEL_VERSION, mode: o.mode, feedback: o.feedback, sessionId: o.sessionId ?? null },
  });
  await touchPlayed(userId, `sim:${best.fp}`, 'sim', created.id);
  return created;
}

/** Recent-history window for situation diversity, and the bound on re-deals. */
export const RECENT_SITUATIONS = 30;
const MAX_DEAL_TRIES = 25;

simRouter.post('/hands', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(Start, req.body ?? {});
  // Only the caller's own open Mixed session can be attached; its practice/rated mode wins.
  const mixed = body.sessionId ? await mixedSessionFor(userId, body.sessionId) : null;
  if (body.sessionId && !mixed) throw notFound('Session not found or already ended');
  res.status(201).json(simView(await createSimHand(userId, { ...body, mode: mixed?.mode ?? body.mode, sessionId: mixed?.id ?? null })));
});

/** Unfinished hands, for resuming on any device. */
simRouter.get('/hands/active', async (req, res) => {
  const userId = requireUser(req);
  const hands = await prisma.simHand.findMany({ where: { userId, status: 'active' }, orderBy: { updatedAt: 'desc' }, take: 10 });
  res.json(hands.map((h) => ({ id: h.id, sessionId: h.sessionId, mode: h.mode, feedback: h.feedback, kind: h.kind, decisions: steps(h).length, updatedAt: h.updatedAt, tableSize: (h.config as unknown as SimConfig).tableSize })));
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
  // progress metadata (practice progress counts decisions whether or not they are graded)
  Object.assign(step, { street: d.info.street, graded: fb.graded, grade: fb.grade ?? null, basis: fb.basis, at: new Date().toISOString() });
  const complete = run.state.complete;
  // Claim the step first (optimistic concurrency): of two simultaneous requests only one may record.
  const claimed = await prisma.simHand.updateMany({
    where: { id: h.id, userId, version: h.version },
    data: { steps: [...st, step] as object, version: { increment: 1 }, ...(complete ? { status: 'complete', completedAt: new Date() } : {}) },
  });
  if (claimed.count === 0) throw new HttpError(409, 'conflict', 'The hand changed on another device; reload it');
  // Only original hands count; replays and branches are exploration and never recorded (no double counting).
  if (h.kind === 'play' && fb.graded && fb.track) {
    const mixed = await mixedSessionFor(userId, h.sessionId);
    const session =
      mixed ||
      (await prisma.trainingSession.findFirst({ where: { userId, kind: 'sim', mode: h.mode, endedAt: null, startedAt: { gt: new Date(Date.now() - 2 * 3600 * 1000) } }, orderBy: { startedAt: 'desc' } })) ||
      (await prisma.trainingSession.create({ data: { userId, kind: 'sim', mode: h.mode } }));
    const pf = d.info.solver; // heads-up push/fold equilibrium
    const fl = d.info.oracle; // postflop library node
    const solver = fb.basis === 'solverEv';
    const street = d.info.street;
    const cfgH = h.config as unknown as SimConfig;
    const heroCards = run.state.players.find((p) => p.id === cfgH.heroPos)!.cards!;
    const cls = classOfCombo(heroCards[0]!, heroCards[1]!);
    // Anti-farming: solver-equivalent spots share a family, so repeats are familiarity-discounted
    const family = pf ? `pf:${pf.role}:${pf.stackBB}:${pf.deadBB}:${pf.heroClass}` : fl ? `pfl:${originOf(h).flop}:${fl.actions.join('/')}:${street}:${cls}` : `sim:${h.id}`;
    const facingBet = d.info.toCallBB > 0;
    const leaks = ((): { leakOpportunities: LeakKey[]; optionLeaks: LeakKey[] } => {
      if (pf) {
        const opp: LeakKey[] = pf.role === 'sbShove' ? ['stackDepthAdjustments', 'excessivePreflopAllIns'] : ['potOdds'];
        const leak: LeakKey = pf.role === 'sbShove' ? (body.action.type === 'fold' ? 'stackDepthAdjustments' : 'excessivePreflopAllIns') : 'potOdds';
        return { leakOpportunities: opp, optionLeaks: isError(fb.grade!) ? [leak] : [] };
      }
      if (fl && !facingBet) {
        const leak: LeakKey = body.action.type === 'check' ? 'underbluffing' : 'overbluffing';
        return { leakOpportunities: ['underbluffing', 'overbluffing'], optionLeaks: isError(fb.grade!) ? [leak] : [] };
      }
      return { leakOpportunities: ['potOdds'], optionLeaks: isError(fb.grade!) ? ['potOdds'] : [] };
    })();
    const outcome = await recordAttempt({
      userId,
      clientAttemptId: body.clientAttemptId,
      sessionId: session.id,
      attemptType: 'decision',
      itemRef: `sim:${h.id}:${st.length}`,
      familyId: family,
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
      heroPosition: cfgH.heroPos,
      effectiveStackBB: pf?.stackBB ?? (fl ? 32 : undefined),
      difficulty: pf ? (Math.abs(pf.evAggressiveBB) < 0.3 ? 4 : Math.abs(pf.evAggressiveBB) < 1 ? 3 : 2) : 3,
      skills: (pf ? ['preflop', 'shortStack'] : fl ? ['flop', 'rangeReading'] : [street, 'math']) as SkillKey[],
      concepts: pf ? ['push-fold', 'full-hand'] : fl ? ['solver-flop', 'full-hand'] : ['pot-odds', 'full-hand'],
      ...leaks,
      sourceClass: solver ? 'SOLVER_VERIFIED' : 'MATH_VERIFIED',
      track: fb.track,
      responseMs: body.responseMs,
      reasoning: step.reasoning,
      result: { kind: 'sim', handId: h.id, decision: st.length, feedback: fb, facts: facts(d.info) },
    });
    step.attemptId = outcome.attemptId;
    // link the attempt to the step (informational; skipped if another step already followed)
    await prisma.simHand.updateMany({ where: { id: h.id, version: h.version + 1 }, data: { steps: [...st, step] as object } });
  }
  if (complete && h.kind === 'play' && h.fingerprint) {
    const all = [...st, step] as (Step & { graded?: boolean; grade?: string | null })[];
    const graded = all.filter((x) => x.graded);
    await markCompleted(userId, `sim:${h.fingerprint}`, 'sim', h.id, {
      result: !graded.length ? 'ungraded' : graded.some((x) => x.grade === 'mistake' || x.grade === 'major') ? 'incorrect' : 'correct',
      ratingEligible: all.some((x) => x.attemptId),
      confidence: body.confidence ?? null,
    });
  }
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
  const r = await prisma.simHand.create({ data: { userId, seed: h.seed, ...(h.deal ? { deal: h.deal as object } : {}), config: h.config as object, modelVersion: h.modelVersion, mode: 'practice', feedback: 'guided', kind: 'replay', parentId: root } });
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
    data: { userId, seed: h.seed, ...(h.deal ? { deal: h.deal as object } : {}), config: h.config as object, modelVersion: h.modelVersion, mode: 'practice', feedback: 'guided', kind: 'branch', parentId: h.parentId ?? h.id, branchAt: body.decisionIndex, steps: prefix as object, status: done ? 'complete' : 'active', completedAt: done ? new Date() : null },
  });
  res.status(201).json(simView(r));
});

/** The original hand with its replays and branches, for side-by-side comparison. */
/**
 * Continue a finished curated scenario as a full hand from its exact end state. A replayed
 * (practice) scenario continues in practice; continuation decisions follow the simulator's grading.
 */
simRouter.post('/from-run/:runId', async (req, res) => {
  const userId = requireUser(req);
  const run = await prisma.scenarioRun.findFirst({ where: { id: String(req.params.runId), userId } });
  if (!run) throw notFound('Run not found');
  if (run.status !== 'completed') throw new HttpError(409, 'not_complete', 'Finish the scenario first');
  const existing = await prisma.simHand.findFirst({ where: { userId, kind: 'play', origin: { path: ['runId'], equals: run.id } } });
  if (existing) return void res.status(200).json(simView(existing));
  const v = await loadVersion(run.scenarioVersionId);
  if (!v) throw notFound('Scenario version missing');
  const sc = v.scenario as Scenario;
  const end = replayScenario(sc, run.steps as never).state;
  if (end.complete) throw new HttpError(409, 'hand_over', 'This hand is already over');
  const { config, deal, prefix } = scenarioContinuation(sc, end, (n) => randomInt(n));
  const seed = randomInt(1, 2 ** 31 - 1);
  const origin: Origin = { kind: 'scenario', scenarioId: sc.id, runId: run.id, prefix };
  const h = await prisma.simHand.create({
    data: { userId, seed, deal: deal as object, config: config as object, origin: origin as object, fingerprint: `scenario:${sc.id}`, modelVersion: SIM_MODEL_VERSION, mode: run.mode, feedback: 'guided', sessionId: run.sessionId },
  });
  res.status(201).json(simView(h));
});

/**
 * Branch Challenge: after the hand, make one Villain take a different legal action and play on.
 * Exploration only — never recorded or rated.
 */
simRouter.post('/hands/:id/branch-villain', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ historyIndex: z.number().int().min(0).max(500), choice: z.enum(['fold', 'passive', 'aggressive']) }), req.body);
  const h = await load(userId, String(req.params.id));
  const run = build(h);
  if (!run.state.complete) throw new HttpError(409, 'not_complete', 'Finish the hand first');
  const ev = run.villainEvents.find((e) => e.historyIndex === body.historyIndex && e.source !== 'scripted');
  if (!ev) throw new HttpError(400, 'invalid_input', 'No modelled Villain decision at that point');
  if (ev.chosen === body.choice) throw new HttpError(400, 'invalid_input', 'That is what Villain already did');
  const keep = steps(h).filter((_, i) => run.decisions[i]!.info.historyIndex < body.historyIndex).map((x) => ({ action: x.action, clientAttemptId: `branch-${x.clientAttemptId}` }));
  const o = originOf(h);
  const origin: Origin = { ...o, villainOverrides: { ...(o.villainOverrides ?? {}), [body.historyIndex]: body.choice } };
  const probe = runSim(h.seed, h.config as unknown as SimConfig, keep.map((x) => x.action), { deal: (h.deal as unknown as SimDeal | null) ?? undefined, prefix: o.prefix, villainOverrides: origin.villainOverrides, oracle: oracleFor(o), equitySamples: 50 });
  const r = await prisma.simHand.create({
    data: { userId, seed: h.seed, ...(h.deal ? { deal: h.deal as object } : {}), config: h.config as object, origin: origin as object, modelVersion: h.modelVersion, mode: 'practice', feedback: 'guided', kind: 'branch', parentId: h.parentId ?? h.id, branchAt: null, steps: keep as object, status: probe.state.complete ? 'complete' : 'active', completedAt: probe.state.complete ? new Date() : null },
  });
  res.status(201).json(simView(r));
});

/**
 * After the hand only: the cards nobody saw — folded opponents' hands and the undealt runout.
 * Simulator-only and hypothetical (labelled); it never changes the recorded result.
 */
simRouter.get('/hands/:id/hidden', async (req, res) => {
  const userId = requireUser(req);
  const h = await load(userId, String(req.params.id));
  const run = build(h);
  if (!run.state.complete) throw new HttpError(409, 'not_complete', 'Available after the hand is over');
  res.json({
    ...simHiddenInfo(run),
    label: {
      en: 'Simulator-only information Hero could not have known. The runout is hypothetical: the hand had already ended.',
      vi: 'Thông tin chỉ có trong mô phỏng mà Hero không thể biết. Lá bài còn lại là giả định: ván đã kết thúc.',
    },
  });
});

/** Bookmark a simulated hand for later review. */
simRouter.post('/hands/:id/bookmark', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ on: z.boolean() }), req.body);
  const h = await load(userId, String(req.params.id));
  await prisma.simHand.update({ where: { id: h.id }, data: { bookmarked: body.on } });
  res.json({ ok: true });
});

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
