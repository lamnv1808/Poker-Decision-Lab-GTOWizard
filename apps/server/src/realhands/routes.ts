import {
  type Grade,
  type HandState,
  type PlayerAction,
  type ReconstructedHand,
  GRADE_SCORE,
  GRADING_METHOD_VERSION,
  IllegalActionError,
  TOPIC_LABELS,
  type Topic,
  applyAction,
  ggParser,
  gradeFromEvLoss,
  DEFAULT_THRESHOLDS,
  initialSrs,
  isError,
  legalActions,
  masteryEstimate,
  publicState,
  reconstructHand,
  reviewSrs,
  snapshotForHeroAction,
} from '@pdl/core';
import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from '../auth';
import { prisma } from '../db';
import { HttpError, notFound, parse } from '../http';
import { recordAttempt } from '../learning';
import { mathFacts } from '../runs';

/* ------------------------------------------------------------------ helpers */

const recCache = new Map<string, ReconstructedHand>();
function rebuild(raw: string, key: string): ReconstructedHand {
  let r = recCache.get(key);
  if (!r) {
    r = reconstructHand(ggParser.parse(raw.trim()));
    if (recCache.size > 200) recCache.delete(recCache.keys().next().value!);
    recCache.set(key, r);
  }
  return r;
}

async function loadDecision(userId: string, id: string) {
  const d = await prisma.realDecision.findFirst({ where: { id, userId }, include: { realHand: true } });
  if (!d) throw notFound('Decision not found');
  if (d.status !== 'accepted') throw new HttpError(409, 'quarantined', 'This record is quarantined and cannot be used for exercises');
  const rec = rebuild(d.realHand.raw, d.realHand.id);
  const snap = snapshotForHeroAction(rec, d.heroActionNo);
  if (!snap) throw new HttpError(500, 'snapshot_failed', 'Could not rebuild the decision');
  return { d, rec, snap };
}

/**
 * Question payload: ONLY what Hero could see at the decision. No future board, no opponent
 * cards, no observed action, no review tags, no final outcome, no raw history.
 */
function questionPayload(d: Awaited<ReturnType<typeof loadDecision>>['d'], rec: ReconstructedHand, snap: NonNullable<ReturnType<typeof snapshotForHeroAction>>) {
  const bb = rec.parsed.bigBlind;
  const missing = ['payout structure (ICM)', 'opponent tendencies'];
  if (d.format === 'PKO') missing.push('bounty sizes (not in hand history)');
  return {
    decisionId: d.id,
    street: d.street,
    format: d.format,
    tournament: rec.parsed.tournamentName,
    level: rec.parsed.level,
    blinds: { smallBlind: rec.parsed.smallBlind, bigBlind: bb, ante: rec.parsed.ante, anteMode: rec.table.anteMode },
    positions: rec.positions,
    heroId: snap.heroId,
    heroCards: rec.parsed.heroCards,
    state: publicState(snap.state, snap.heroId),
    legal: legalActions(snap.state),
    bigBlind: bb,
    stackDepthBB: round(d.stackDepthBB, 2),
    potBB: round(snap.potBB, 2),
    toCallBB: round(snap.callAmountBB, 2),
    playersInPot: d.playersInPot,
    missingInfo: missing,
  };
}
const round = (x: number, k = 2) => Math.round(x * 10 ** k) / 10 ** k;

const Filters = z.object({
  street: z.enum(['preflop', 'flop', 'turn', 'river']).optional(),
  topic: z.string().max(40).optional(),
  minStack: z.coerce.number().optional(),
  maxStack: z.coerce.number().optional(),
  minPot: z.coerce.number().optional(),
  maxPot: z.coerce.number().optional(),
  minFaced: z.coerce.number().optional(),
  maxFaced: z.coerce.number().optional(),
  minInvested: z.coerce.number().optional(),
  multiway: z.enum(['true', 'false']).optional(),
  format: z.string().max(20).optional(),
  split: z.enum(['training', 'assessment']).optional(),
});
type FiltersT = z.infer<typeof Filters>;

function whereFrom(userId: string, f: FiltersT): Prisma.RealDecisionWhereInput {
  return {
    userId,
    status: 'accepted',
    street: f.street,
    format: f.format || undefined,
    split: f.split,
    multiway: f.multiway === undefined ? undefined : f.multiway === 'true',
    topics: f.topic ? { has: f.topic } : undefined,
    stackDepthBB: { gte: f.minStack ?? undefined, lte: f.maxStack ?? undefined },
    potBB: { gte: f.minPot ?? undefined, lte: f.maxPot ?? undefined },
    toCallBB: { gte: f.minFaced ?? undefined, lte: f.maxFaced ?? undefined },
    investedBB: { gte: f.minInvested ?? undefined },
  };
}

async function latestVerified(decisionId: string) {
  return prisma.annotation.findFirst({ where: { decisionId, status: 'verified' }, orderBy: { version: 'desc' } });
}

interface Evaluated {
  action: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
  sizeToBB?: number | 'all-in' | null;
  ev?: number | null;
  freq?: number | null;
}

/** Classify the learner's engine action in annotation terms. */
function describeAction(state: HandState, a: PlayerAction) {
  const legal = legalActions(state)!;
  const bb = state.config.bigBlind;
  const me = state.players[state.toAct]!;
  if (a.type === 'fold' || a.type === 'check') return { action: a.type, toBB: null as number | null, addedBB: 0, allIn: false };
  if (a.type === 'call') return { action: legal.callIsAllIn ? ('allin' as const) : ('call' as const), toBB: null, addedBB: legal.callAmount / bb, allIn: legal.callIsAllIn };
  const allIn = a.amount === legal.maxRaiseTo;
  return { action: allIn ? ('allin' as const) : a.type, toBB: (a.amount ?? 0) / bb, addedBB: ((a.amount ?? 0) - me.streetCommitted) / bb, allIn };
}

/** Match the chosen action to an evaluated entry. Unsupported sizes return null ("Not evaluated"). */
export function matchEvaluated(evaluated: Evaluated[], chosen: ReturnType<typeof describeAction>): Evaluated | null {
  for (const e of evaluated) {
    if (e.action === 'allin' && chosen.allIn) return e;
    if (e.action !== chosen.action) continue;
    if (e.action === 'bet' || e.action === 'raise') {
      if (typeof e.sizeToBB !== 'number' || chosen.toBB === null) continue;
      const tol = Math.max(0.25, 0.1 * e.sizeToBB);
      if (Math.abs(chosen.toBB - e.sizeToBB) <= tol) return e;
      continue;
    }
    return e;
  }
  return null;
}

/* ------------------------------------------------------------------ router */

export const realRouter = Router();

realRouter.get('/coverage', async (req, res) => {
  const userId = requireUser(req);
  const [hands, decisions, quizzes, ann, bySplit] = await Promise.all([
    prisma.realHand.groupBy({ by: ['status'], where: { userId }, _count: true }),
    prisma.realDecision.groupBy({ by: ['status', 'street'], where: { userId }, _count: true }),
    prisma.$queryRaw<{ status: string; n: bigint }[]>`SELECT "potOdds"->>'status' AS status, count(*) AS n FROM "RealDecision" WHERE "userId" = ${userId} AND "potOdds" IS NOT NULL GROUP BY 1`,
    prisma.annotation.groupBy({ by: ['status', 'source'], where: { userId }, _count: true }),
    prisma.realDecision.groupBy({ by: ['split'], where: { userId, status: 'accepted' }, _count: true }),
  ]);
  const reasons = await prisma.$queryRaw<{ code: string; n: bigint }[]>`SELECT i->>'code' AS code, count(*) AS n FROM "RealDecision", jsonb_array_elements(issues) i WHERE "userId" = ${userId} AND status = 'quarantined' GROUP BY 1 ORDER BY 2 DESC`;
  const handReasons = await prisma.$queryRaw<{ code: string; n: bigint }[]>`SELECT i->>'code' AS code, count(*) AS n FROM "RealHand", jsonb_array_elements(issues) i WHERE "userId" = ${userId} AND status = 'quarantined' GROUP BY 1 ORDER BY 2 DESC`;
  const quizReasons = await prisma.$queryRaw<{ code: string; n: bigint }[]>`SELECT i->>'code' AS code, count(*) AS n FROM "RealDecision", jsonb_array_elements("potOdds"->'issues') i WHERE "userId" = ${userId} AND "potOdds"->>'status' = 'quarantined' GROUP BY 1 ORDER BY 2 DESC`;
  const n = (x: bigint) => Number(x);
  res.json({
    hands: Object.fromEntries(hands.map((h) => [h.status, h._count])),
    handQuarantineReasons: Object.fromEntries(handReasons.map((r) => [r.code, n(r.n)])),
    decisions: decisions.map((d) => ({ status: d.status, street: d.street, n: d._count })),
    decisionQuarantineReasons: Object.fromEntries(reasons.map((r) => [r.code, n(r.n)])),
    potOddsQuizzes: Object.fromEntries(quizzes.map((q) => [q.status, n(q.n)])),
    potOddsQuarantineReasons: Object.fromEntries(quizReasons.map((r) => [r.code, n(r.n)])),
    annotations: ann.map((a) => ({ status: a.status, source: a.source, n: a._count })),
    splits: Object.fromEntries(bySplit.map((s) => [s.split, s._count])),
  });
});

/** Pick the next exercise. Concept reviews first; never the family just played. */
realRouter.post('/next', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ kind: z.enum(['replay', 'strategy', 'potodds']), filters: Filters.default({}), excludeFamilyId: z.string().max(60).optional() }), req.body);
  const where = whereFrom(userId, body.filters);
  if (body.excludeFamilyId) where.familyId = { not: body.excludeFamilyId };
  if (body.kind === 'strategy') where.annotations = { some: { status: 'verified' } };
  if (body.kind === 'potodds') where.potOdds = { path: ['status'], equals: 'accepted' };
  let topic: string | null = null;
  if (body.kind !== 'potodds' && !body.filters.topic) {
    const due = await prisma.reviewItem.findFirst({ where: { userId, itemType: 'concept', dueAt: { lte: new Date() } }, orderBy: { dueAt: 'asc' } });
    if (due) {
      const n = await prisma.realDecision.count({ where: { ...where, topics: { has: due.itemRef } } });
      if (n) {
        topic = due.itemRef;
        where.topics = { has: topic };
      }
    }
  }
  const count = await prisma.realDecision.count({ where });
  if (!count) throw new HttpError(404, 'none', 'No decisions match these filters');
  // Prefer decisions this user has not attempted yet.
  const attempted = await prisma.decisionAttempt.findMany({ where: { userId, attemptType: { in: ['replay', 'real', 'potodds'] } }, select: { itemRef: true }, distinct: ['itemRef'], take: 5000 });
  const seen = attempted.map((a) => a.itemRef.split(':').pop()!).filter(Boolean);
  const fresh = await prisma.realDecision.count({ where: { ...where, id: { notIn: seen } } });
  const pickWhere = fresh ? { ...where, id: { notIn: seen } } : where;
  const total = fresh || count;
  const skip = Math.floor(Math.random() * total);
  const pick = await prisma.realDecision.findFirst({ where: pickWhere, skip, select: { id: true } });
  const { d, rec, snap } = await loadDecision(userId, pick!.id);
  const payload = questionPayload(d, rec, snap);
  res.json({
    ...payload,
    kind: body.kind,
    pickReason: topic ? 'concept-review' : fresh ? 'new' : 'repeat',
    reviewTopic: topic ? { key: topic, label: TOPIC_LABELS[topic as Topic] } : null,
    poolSize: count,
    potOddsPrompt:
      body.kind === 'potodds'
        ? {
            terminal: (d.potOdds as { terminal?: boolean })?.terminal ?? false,
            vi: 'Equity hòa vốn cần thiết để theo là bao nhiêu (%)? Chỉ tính chip EV, chưa xét ICM/bounty. Đây không phải câu hỏi nên theo hay bỏ.',
            en: 'What equity do you need to break even on a call (%)? Chip EV only, no ICM/bounty. This is not a call-or-fold recommendation.',
          }
        : null,
  });
});

realRouter.get('/decisions/:id/question', async (req, res) => {
  const userId = requireUser(req);
  const { d, rec, snap } = await loadDecision(userId, String(req.params.id));
  res.json(questionPayload(d, rec, snap));
});

const ActionInput = z.object({ type: z.enum(['fold', 'check', 'call', 'bet', 'raise']), amount: z.number().int().positive().optional() });

async function scheduleConcept(userId: string, topics: string[], grade: Grade) {
  const now = new Date();
  for (const t of topics) {
    const where = { userId_itemType_itemRef: { userId, itemType: 'concept', itemRef: t } };
    const item = await prisma.reviewItem.findUnique({ where });
    if (!item && !(isError(grade) || grade === 'marginal')) continue;
    const prev = item ? { repetitions: item.repetitions, ease: item.ease, intervalDays: item.intervalDays, dueAt: item.dueAt.toISOString(), lastQuality: item.lastQuality, lapses: item.lapses } : initialSrs(now);
    const next = reviewSrs(prev, grade, now);
    const data = { repetitions: next.repetitions, ease: next.ease, intervalDays: next.intervalDays, dueAt: new Date(next.dueAt), lastQuality: next.lastQuality, lapses: next.lapses, mastery: masteryEstimate(next), lastAttemptAt: now, lastGrade: grade };
    await prisma.reviewItem.upsert({ where, create: { userId, itemType: 'concept', itemRef: t, ...data }, update: data });
  }
}

/**
 * Submit a replay answer: action + sizing + reasoning + confidence are required BEFORE any reveal.
 * Without a verified annotation the answer is recorded but never judged.
 */
realRouter.post('/decisions/:id/answer', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(
    z.object({
      clientAttemptId: z.string().min(8).max(100),
      action: ActionInput,
      reasoning: z.string().trim().min(3).max(2000),
      confidence: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      responseMs: z.number().int().min(0).max(3_600_000).optional(),
      mode: z.enum(['practice', 'rated']).default('practice'),
    }),
    req.body,
  );
  const { d, rec, snap } = await loadDecision(userId, String(req.params.id));
  const dup = await prisma.decisionAttempt.findUnique({ where: { userId_clientAttemptId: { userId, clientAttemptId: body.clientAttemptId } } });
  if (dup) return void res.json(dup.result);
  try {
    applyAction(snap.state, body.action);
  } catch (e) {
    if (e instanceof IllegalActionError) throw new HttpError(400, 'illegal_action', e.message);
    throw e;
  }
  const bb = rec.parsed.bigBlind;
  const chosen = describeAction(snap.state, body.action);
  const observed = d.observed as { type: string; amountBB: number; allIn: boolean };
  const ann = await latestVerified(d.id);
  let strategy: Record<string, unknown> = { status: 'unreviewed' };
  let graded = false;
  let grade: Grade | undefined;
  let evLoss: number | undefined;
  let ratingEligible = false;
  if (ann) {
    const evaluated = ann.evaluated as unknown as Evaluated[];
    const m = matchEvaluated(evaluated, chosen);
    const evs = evaluated.filter((e) => typeof e.ev === 'number');
    const base = { status: 'verified', annotationId: ann.id, version: ann.version, source: ann.source, recommendation: ann.recommendation, explanationVi: ann.explanationVi, explanationEn: ann.explanationEn, confidence: ann.confidence, scope: ann.scope, assumedRanges: ann.assumedRanges, economics: ann.economics, missingInfo: ann.missingInfo, solverMeta: ann.solverMeta, evaluated };
    if (!m) strategy = { ...base, evaluation: 'not_evaluated' };
    else if (evs.length >= 2 && typeof m.ev === 'number') {
      const best = Math.max(...evs.map((e) => e.ev!));
      evLoss = Math.max(0, best - m.ev);
      const tol = ann.toleranceBB ?? 0.05;
      const inMix = (m.freq ?? 0) >= 0.1;
      grade = evLoss <= tol || (inMix && evLoss <= 3 * tol) ? 'excellent' : gradeFromEvLoss(evLoss, DEFAULT_THRESHOLDS.bb);
      graded = true;
      ratingEligible = d.split === 'assessment';
      strategy = { ...base, evaluation: 'ev', matched: m, evLossBB: round(evLoss, 3), grade, toleranceBB: tol };
    } else {
      // Qualitative recommendation: no EV is invented, so no grade or rating.
      strategy = { ...base, evaluation: 'qualitative', matched: m };
    }
  }
  const facts = mathFacts(snap.state, bb, body.action);
  const topics = d.topics as Topic[];
  const result = {
    decisionId: d.id,
    street: d.street,
    yourAction: { ...chosen, toBB: chosen.toBB === null ? null : round(chosen.toBB), addedBB: round(chosen.addedBB) },
    observed: { ...observed, label: 'historical', note: { en: 'What Hero actually did. Historical behaviour — not a correct answer.', vi: 'Hành động Hero đã thực hiện. Đây là hành vi lịch sử — không phải đáp án đúng.' } },
    sameAsObserved: observed.type === body.action.type || (observed.allIn && chosen.allIn),
    facts,
    topics: topics.map((t) => ({ key: t, label: TOPIC_LABELS[t] })),
    strategy,
    reasoning: body.reasoning,
    confidence: body.confidence,
  };
  const outcome = await recordAttempt({
    userId,
    clientAttemptId: body.clientAttemptId,
    attemptType: 'replay',
    itemRef: `real:${d.familyId}:${d.id}`,
    reviewType: 'real',
    reviewRef: d.id,
    mode: graded ? body.mode : 'practice',
    action: body.action,
    optionKey: chosen.action,
    graded,
    grade,
    gradeBasis: graded ? (ann!.source === 'solver' ? 'solverEv' : 'modelEv') : 'none',
    evLoss,
    evUnit: graded ? 'bb' : undefined,
    ratingEligible,
    isError: grade ? isError(grade) : false,
    confidence: body.confidence,
    gradingMethodVersion: ann ? `${GRADING_METHOD_VERSION}+ann-v${ann.version}` : 'replay-ungraded-v1',
    street: d.street,
    heroPosition: rec.heroPosition ?? undefined,
    effectiveStackBB: d.stackDepthBB,
    difficulty: 3,
    skills: graded ? [d.street as 'preflop', ...(d.stackDepthBB <= 15 ? (['shortStack'] as const) : [])] : [],
    concepts: topics,
    leakOpportunities: [],
    optionLeaks: [],
    sourceClass: ann ? (ann.source === 'solver' ? 'SOLVER_VERIFIED' : ann.source === 'human' ? 'COACH_REVIEWED' : 'MATH_VERIFIED') : 'EXPERIMENTAL',
    track: graded ? 'strategy' : 'replay',
    familyId: d.familyId,
    responseMs: body.responseMs ?? null,
    reasoning: body.reasoning,
    annotationId: ann?.id ?? null,
    result,
  });
  // Concept-level spaced repetition: low confidence or a judged mistake schedules the topic.
  const conceptGrade: Grade | null = grade ?? (body.confidence === 1 ? 'marginal' : null);
  if (conceptGrade) await scheduleConcept(userId, topics, conceptGrade);
  void GRADE_SCORE;
  res.json(outcome.result);
});

/** The rest of the real hand, available only after the learner has answered. Labelled historical. */
realRouter.get('/decisions/:id/outcome', async (req, res) => {
  const userId = requireUser(req);
  const { d, rec, snap } = await loadDecision(userId, String(req.params.id));
  const answered = await prisma.decisionAttempt.count({ where: { userId, itemRef: { endsWith: `:${d.id}` } } });
  if (!answered) throw new HttpError(403, 'answer_first', 'Submit an answer before viewing what happened');
  const bb = rec.parsed.bigBlind;
  res.json({
    label: { en: 'What actually happened (historical record)', vi: 'Diễn biến thực tế (dữ liệu lịch sử)' },
    actions: rec.parsed.actions.slice(snap.actionIndex).map((a) => ({ street: a.street, player: rec.positions[a.player] ?? a.player, type: a.type, amountBB: round(a.amount / bb), allIn: a.allIn })),
    board: rec.parsed.board,
    shown: rec.parsed.shown.map((s) => ({ player: rec.positions[s.player] ?? s.player, cards: s.cards })),
    collected: rec.parsed.collected.map((c) => ({ player: rec.positions[c.player] ?? c.player, amountBB: round(c.amount / bb) })),
    note: { en: 'Results do not show whether a decision was correct.', vi: 'Kết quả không cho biết quyết định đúng hay sai.' },
  });
});

/* -------------------------------------------------------------- fundamentals */

realRouter.post('/potodds/:id/answer', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ clientAttemptId: z.string().min(8).max(100), valuePct: z.number().min(0).max(100), responseMs: z.number().int().min(0).max(3_600_000).optional(), confidence: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }), req.body);
  const { d, snap } = await loadDecision(userId, String(req.params.id));
  const po = d.potOdds as { status: string; requiredEquity: number; terminal: boolean; supplied: number } | null;
  if (!po || po.status !== 'accepted') throw new HttpError(409, 'no_quiz', 'No validated pot-odds benchmark for this decision');
  const truth = po.requiredEquity * 100;
  const err = Math.abs(body.valuePct - truth);
  const tol = 0.5;
  const grade: Grade = err <= tol ? 'excellent' : err <= 2 * tol ? 'good' : err <= 4 * tol ? 'acceptable' : err <= 6 * tol ? 'marginal' : err <= 10 * tol ? 'mistake' : 'major';
  const bb = snap.state.config.bigBlind;
  const legal = snap.legal!;
  const result = {
    decisionId: d.id,
    valuePct: body.valuePct,
    answerPct: round(truth, 2),
    tolerancePct: tol,
    grade,
    callBB: round(legal.callAmount / bb),
    winnablePotAfterCallBB: round(legal.callAmount / po.requiredEquity / bb),
    formula: 'call / (pot you can win after calling)',
    scope: po.terminal
      ? { en: 'Calling ends the betting (all-in or river): exact chip-EV break-even.', vi: 'Theo là kết thúc cược (all-in hoặc river): điểm hòa vốn chip EV chính xác.' }
      : { en: 'Assumes no further betting on later streets; real equity realization differs.', vi: 'Giả định không còn cược ở các vòng sau; hiện thực hóa equity thực tế sẽ khác.' },
    note: { en: 'Arithmetic benchmark only — pot odds alone do not decide whether to call; Hero’s equity vs the opponent’s range is unknown.', vi: 'Chỉ là bài tập số học — pot odds riêng nó không quyết định nên theo; equity của Hero so với range đối thủ chưa biết.' },
  };
  const outcome = await recordAttempt({
    userId,
    clientAttemptId: body.clientAttemptId,
    attemptType: 'potodds',
    itemRef: `potodds:${d.familyId}:${d.id}`,
    reviewType: 'quiz',
    reviewRef: 'potodds',
    mode: 'practice',
    action: { valuePct: body.valuePct },
    graded: true,
    grade,
    gradeBasis: 'exact',
    ratingEligible: false,
    isError: isError(grade),
    confidence: body.confidence,
    gradingMethodVersion: 'potodds-winnable-v1',
    street: d.street,
    difficulty: 2,
    skills: ['math'],
    concepts: ['pot-odds'],
    leakOpportunities: ['potOdds'],
    optionLeaks: isError(grade) ? ['potOdds'] : [],
    sourceClass: 'MATH_VERIFIED',
    track: 'fundamentals',
    familyId: d.familyId,
    responseMs: body.responseMs ?? null,
    result,
  });
  res.json(outcome.result);
});

/* ---------------------------------------------------------------- annotation */

realRouter.get('/review', async (req, res) => {
  const userId = requireUser(req);
  const q = parse(Filters.extend({ annotation: z.enum(['any', 'none', 'draft', 'verified']).default('any'), status: z.enum(['accepted', 'quarantined']).default('accepted'), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(5).max(100).default(25) }), req.query);
  const where = { ...whereFrom(userId, q), status: q.status };
  if (q.annotation === 'none') where.annotations = { none: {} };
  if (q.annotation === 'draft') where.annotations = { some: { status: 'draft' } };
  if (q.annotation === 'verified') where.annotations = { some: { status: 'verified' } };
  const [total, rows] = await Promise.all([
    prisma.realDecision.count({ where }),
    prisma.realDecision.findMany({
      where,
      orderBy: [{ investedBB: 'desc' }, { potBB: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { id: true, externalId: true, street: true, stackDepthBB: true, potBB: true, toCallBB: true, investedBB: true, playersInPot: true, multiway: true, facingAllIn: true, format: true, topics: true, reviewTags: true, split: true, playedAt: true, issues: true, annotations: { select: { id: true, status: true, version: true, source: true }, orderBy: { version: 'desc' }, take: 1 } },
    }),
  ]);
  res.json({ total, page: q.page, pageSize: q.pageSize, rows });
});

/** Reviewer view: the decision as Hero saw it, plus the observed action and full annotation history. */
realRouter.get('/decisions/:id/review', async (req, res) => {
  const userId = requireUser(req);
  const { d, rec, snap } = await loadDecision(userId, String(req.params.id));
  const history = await prisma.annotation.findMany({ where: { decisionId: d.id }, orderBy: { version: 'desc' } });
  res.json({ question: questionPayload(d, rec, snap), observed: d.observed, reviewTags: d.reviewTags, topics: d.topics, split: d.split, potOdds: d.potOdds, annotations: history });
});

const EvaluatedSchema = z.array(
  z.object({
    action: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allin']),
    sizeToBB: z.union([z.number().positive(), z.literal('all-in'), z.null()]).optional(),
    ev: z.number().nullable().optional(),
    freq: z.number().min(0).max(1).nullable().optional(),
  }),
).min(1);

const AnnotationInput = z.object({
  source: z.enum(['calculation', 'human', 'solver']),
  authorKind: z.enum(['human', 'ai']).default('human'),
  infoAvailable: z.record(z.string(), z.unknown()).default({}),
  assumedRanges: z.array(z.object({ player: z.string().max(40), range: z.string().max(2000), justification: z.string().max(2000) })).default([]),
  economics: z.object({ chipEV: z.boolean().default(true), icm: z.string().max(500).default('not modelled'), bounty: z.string().max(500).default('not modelled') }),
  missingInfo: z.array(z.string().max(200)).default([]),
  evaluated: EvaluatedSchema,
  recommendation: z.string().trim().min(1).max(500),
  explanationVi: z.string().trim().min(1).max(5000),
  explanationEn: z.string().max(5000).optional(),
  confidence: z.enum(['low', 'medium', 'high']),
  scope: z.string().trim().min(1).max(2000),
  solverMeta: z.object({ name: z.string(), version: z.string(), config: z.unknown(), convergence: z.unknown() }).optional(),
  toleranceBB: z.number().min(0).max(5).optional(),
});

realRouter.post('/decisions/:id/annotations', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(AnnotationInput, req.body);
  const d = await prisma.realDecision.findFirst({ where: { id: String(req.params.id), userId } });
  if (!d) throw notFound();
  if (body.source === 'solver' && !body.solverMeta) throw new HttpError(400, 'invalid_input', 'Solver annotations need solver name, version, configuration and convergence');
  if (body.source !== 'solver' && body.evaluated.some((e) => typeof e.freq === 'number')) throw new HttpError(400, 'invalid_input', 'Frequencies may only come from a solver');
  const last = await prisma.annotation.findFirst({ where: { decisionId: d.id }, orderBy: { version: 'desc' } });
  const a = await prisma.annotation.create({
    data: {
      decisionId: d.id,
      userId,
      version: (last?.version ?? 0) + 1,
      status: 'draft', // everything starts as draft; AI output in particular is never auto-verified
      source: body.source,
      authorKind: body.authorKind,
      infoAvailable: body.infoAvailable as object,
      assumedRanges: body.assumedRanges as object,
      economics: body.economics as object,
      missingInfo: body.missingInfo,
      evaluated: body.evaluated as object,
      recommendation: body.recommendation,
      explanationVi: body.explanationVi,
      explanationEn: body.explanationEn,
      confidence: body.confidence,
      scope: body.scope,
      solverMeta: (body.solverMeta as object) ?? undefined,
      toleranceBB: body.toleranceBB,
      supersedesId: last?.id ?? null,
    },
  });
  res.status(201).json(a);
});

/** A human verifies a draft. The previously verified version (if any) is retired, never edited. */
realRouter.post('/annotations/:id/verify', async (req, res) => {
  const userId = requireUser(req);
  const a = await prisma.annotation.findFirst({ where: { id: String(req.params.id), userId } });
  if (!a) throw notFound();
  if (a.status !== 'draft') throw new HttpError(409, 'not_draft', 'Only drafts can be verified');
  const confirm = parse(z.object({ confirm: z.literal(true) }), req.body);
  void confirm;
  await prisma.$transaction([
    prisma.annotation.updateMany({ where: { decisionId: a.decisionId, status: 'verified' }, data: { status: 'retired' } }),
    prisma.annotation.update({ where: { id: a.id }, data: { status: 'verified', verifiedById: userId, verifiedAt: new Date() } }),
  ]);
  res.json(await prisma.annotation.findUnique({ where: { id: a.id } }));
});

realRouter.post('/annotations/:id/retire', async (req, res) => {
  const userId = requireUser(req);
  const a = await prisma.annotation.findFirst({ where: { id: String(req.params.id), userId } });
  if (!a) throw notFound();
  res.json(await prisma.annotation.update({ where: { id: a.id }, data: { status: 'retired' } }));
});

/* ------------------------------------------------------------------ metrics */

realRouter.get('/metrics', async (req, res) => {
  const userId = requireUser(req);
  const rows = await prisma.decisionAttempt.findMany({
    where: { userId },
    select: { track: true, graded: true, isError: true, grade: true, evLoss: true, evUnit: true, confidence: true, responseMs: true, familyId: true, street: true, concepts: true, annotationId: true, gradingMethodVersion: true, createdAt: true },
  });
  const by = <T,>(xs: T[], k: (x: T) => string | null | undefined) => {
    const m = new Map<string, T[]>();
    for (const x of xs) {
      const key = k(x);
      if (key == null) continue;
      m.set(key, [...(m.get(key) ?? []), x]);
    }
    return m;
  };
  const summary = (xs: typeof rows) => {
    const g = xs.filter((x) => x.graded);
    const ev = g.filter((x) => x.evUnit === 'bb' && x.evLoss !== null);
    const rt = xs.filter((x) => x.responseMs !== null).map((x) => x.responseMs!);
    return {
      attempts: xs.length,
      graded: g.length,
      accuracyPct: g.length ? Math.round((1000 * g.filter((x) => !x.isError).length) / g.length) / 10 : null,
      avgEvLossBB: ev.length ? Math.round((1000 * ev.reduce((s, x) => s + x.evLoss!, 0)) / ev.length) / 1000 : null,
      uniqueFamilies: new Set(xs.map((x) => x.familyId).filter(Boolean)).size,
      medianResponseSec: rt.length ? Math.round(rt.sort((a, b) => a - b)[Math.floor(rt.length / 2)]! / 100) / 10 : null,
    };
  };
  const tracks = Object.fromEntries([...by(rows, (r) => r.track)].map(([k, xs]) => [k, summary(xs)]));
  const strategy = rows.filter((r) => r.track === 'strategy' && r.graded);
  const calibration = [1, 2, 3].map((c) => {
    const xs = strategy.filter((r) => r.confidence === c);
    return { confidence: c, n: xs.length, accuracyPct: xs.length ? Math.round((1000 * xs.filter((x) => !x.isError).length) / xs.length) / 10 : null };
  });
  const repeatedMistakes = [...by(strategy.filter((r) => r.isError), (r) => r.concepts[0] ?? null)].filter(([, xs]) => xs.length >= 2).map(([k, xs]) => ({ concept: k, errors: xs.length }));
  const byTopic = [...by(rows.filter((r) => r.track !== 'fundamentals').flatMap((r) => r.concepts.map((c) => ({ ...r, concept: c }))), (r) => r.concept)].map(([k, xs]) => ({ key: k, ...summary(xs as typeof rows) }));
  const byStreet = [...by(rows.filter((r) => r.track !== 'fundamentals'), (r) => r.street)].map(([k, xs]) => ({ key: k, ...summary(xs) }));
  // Scores graded against different annotation versions are reported separately, never pooled.
  const byStandard = [...by(strategy, (r) => (r.annotationId ? `${r.gradingMethodVersion}:${r.annotationId}` : r.gradingMethodVersion))].map(([k, xs]) => ({ standard: k, ...summary(xs) }));
  res.json({ tracks, calibration, repeatedMistakes, byTopic, byStreet, byStandard, topicLabels: TOPIC_LABELS });
});
